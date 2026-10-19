import { useEffect, useState } from "react";
import type { AgentRateLimitCooldownPayload } from "@getpaseo/protocol/messages";

export function useIsRateLimitCooldownActive(
  cooldown: AgentRateLimitCooldownPayload | null | undefined,
): boolean {
  const [isActive, setIsActive] = useState(() => isRateLimitCooldownActive(cooldown));

  useEffect(() => {
    if (!cooldown?.scheduledFor) {
      setIsActive(false);
      return;
    }
    const targetMs = new Date(cooldown.scheduledFor).getTime();
    if (Number.isNaN(targetMs)) {
      setIsActive(false);
      return;
    }
    const diff = targetMs - Date.now();
    if (diff <= 0) {
      setIsActive(false);
      return;
    }
    setIsActive(true);
    const timeout = setTimeout(() => {
      setIsActive(false);
    }, diff);
    return () => clearTimeout(timeout);
  }, [cooldown?.scheduledFor]);

  return isActive;
}

export function isRateLimitCooldownActive(
  cooldown: AgentRateLimitCooldownPayload | null | undefined,
  now = Date.now(),
): boolean {
  if (!cooldown?.scheduledFor) return false;
  const time = new Date(cooldown.scheduledFor).getTime();
  return !Number.isNaN(time) && time > now;
}

export function formatCooldownCountdown(remainingMs: number): string {
  if (remainingMs <= 0) {
    return "0s";
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function formatCooldownTimeUtc(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds} UTC`;
}

export interface RateLimitCooldownState {
  isActive: boolean;
  remainingMs: number;
  countdownText: string;
  formattedUtc: string;
  consecutiveResumes?: number;
}

export function useRateLimitCooldown(
  cooldown: AgentRateLimitCooldownPayload | null | undefined,
): RateLimitCooldownState {
  const scheduledTime = cooldown?.scheduledFor ? new Date(cooldown.scheduledFor).getTime() : null;

  const [remainingMs, setRemainingMs] = useState<number>(() => {
    if (!scheduledTime) return 0;
    return Math.max(0, scheduledTime - Date.now());
  });

  useEffect(() => {
    if (!scheduledTime) {
      setRemainingMs(0);
      return;
    }

    const update = () => {
      const diff = Math.max(0, scheduledTime - Date.now());
      setRemainingMs(diff);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [scheduledTime]);

  if (!cooldown || !scheduledTime) {
    return {
      isActive: false,
      remainingMs: 0,
      countdownText: "0s",
      formattedUtc: "",
      consecutiveResumes: undefined,
    };
  }

  const targetDate = new Date(cooldown.scheduledFor);
  const formattedUtc = Number.isNaN(targetDate.getTime()) ? "" : formatCooldownTimeUtc(targetDate);

  return {
    isActive: remainingMs > 0,
    remainingMs,
    countdownText: formatCooldownCountdown(remainingMs),
    formattedUtc,
    consecutiveResumes: cooldown.consecutiveResumes,
  };
}
