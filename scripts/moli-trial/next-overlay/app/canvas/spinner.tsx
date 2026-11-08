"use client";
import { useEffect, useRef, useState } from "react";

export function Spinner() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState(0);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    let n = 0;
    let raf = 0;
    const draw = (t: number) => {
      if (!ctx) return;
      n++;
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = `hsl(${(n * 3) % 360} 80% 55%)`;
      ctx.save();
      ctx.translate(200, 150);
      ctx.rotate(t / 400);
      ctx.fillRect(-60, -60, 120, 120);
      ctx.restore();
      if (n % 10 === 0) setFrames(n);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div>
      <canvas ref={ref} width={400} height={300} />
      <p id="frames">frames: {frames}</p>
    </div>
  );
}
