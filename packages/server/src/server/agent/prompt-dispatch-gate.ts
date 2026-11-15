// The one gate every prompt to an agent passes before it steers into the running turn, replaces
// it, or starts a turn. A provider refuses a steer while it compacts, and the fallback for a refused
// steer replaces the turn, which cancels the compaction. So no prompt goes out while the agent
// compacts, and prompts go out one at a time in arrival order: released together, each would find
// the agent idle and the later ones would replace the turn the first one started.

interface Ticket {
  admit(): void;
  onHold?: () => void;
  held: boolean;
}

interface AgentGate {
  compacting: boolean;
  /** Prompts waiting, in arrival order. */
  queue: Ticket[];
  /** The prompt going out now; the next waits until it is released. */
  admitted: Ticket | null;
  /** Resolved when the running compaction ends. */
  compactionEnded: Promise<void> | null;
  endCompaction: (() => void) | null;
}

export interface PromptDispatchAdmission {
  /** Lets the next prompt go; call once this prompt has steered, started or been skipped. */
  release(): void;
}

export class PromptDispatchGate {
  private readonly gates = new Map<string, AgentGate>();

  /**
   * Resolves once this prompt is first in line and the agent is not compacting. `onHold` runs
   * when it has to wait for a compaction, so a person's send can be answered as queued.
   */
  async admit(
    agentId: string,
    options?: { onHold?: () => void },
  ): Promise<PromptDispatchAdmission> {
    const gate = this.gateFor(agentId);
    const admitted = new Promise<void>((resolve) => {
      gate.queue.push({ admit: resolve, onHold: options?.onHold, held: false });
    });
    this.advance(gate);
    await admitted;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        gate.admitted = null;
        this.advance(gate);
        this.forgetIdle(agentId, gate);
      },
    };
  }

  isCompacting(agentId: string): boolean {
    return this.gates.get(agentId)?.compacting === true;
  }

  /** Resolves when the running compaction ends; at once when the agent is not compacting. */
  async untilCompactionEnds(agentId: string): Promise<void> {
    await this.gates.get(agentId)?.compactionEnded;
  }

  compactionStarted(agentId: string): void {
    const gate = this.gateFor(agentId);
    if (gate.compacting) return;
    gate.compacting = true;
    gate.compactionEnded = new Promise<void>((resolve) => {
      gate.endCompaction = resolve;
    });
    this.holdWaiting(gate);
  }

  /** The compaction completed, gave up with its turn, or the agent closed. */
  compactionEnded(agentId: string): void {
    const gate = this.gates.get(agentId);
    if (!gate?.compacting) return;
    gate.compacting = false;
    gate.endCompaction?.();
    gate.compactionEnded = null;
    gate.endCompaction = null;
    this.advance(gate);
    this.forgetIdle(agentId, gate);
  }

  private gateFor(agentId: string): AgentGate {
    let gate = this.gates.get(agentId);
    if (!gate) {
      gate = {
        compacting: false,
        queue: [],
        admitted: null,
        compactionEnded: null,
        endCompaction: null,
      };
      this.gates.set(agentId, gate);
    }
    return gate;
  }

  private advance(gate: AgentGate): void {
    if (gate.compacting) {
      this.holdWaiting(gate);
      return;
    }
    if (gate.admitted) return;
    const next = gate.queue.shift();
    if (!next) return;
    gate.admitted = next;
    next.admit();
  }

  private holdWaiting(gate: AgentGate): void {
    for (const ticket of gate.queue) {
      if (ticket.held) continue;
      ticket.held = true;
      ticket.onHold?.();
    }
  }

  private forgetIdle(agentId: string, gate: AgentGate): void {
    if (!gate.compacting && !gate.admitted && gate.queue.length === 0) this.gates.delete(agentId);
  }
}
