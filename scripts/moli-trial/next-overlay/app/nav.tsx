import Link from "next/link";

const navStyle = { display: "flex", gap: 16, padding: 16, borderBottom: "1px solid #ccc" };

export function Nav() {
  return (
    <nav style={navStyle}>
      <Link href="/">Home</Link>
      <Link href="/about">About</Link>
      <Link href="/dashboard">Dashboard</Link>
      <Link href="/canvas">Canvas</Link>
      <Link href="/login">Login</Link>
    </nav>
  );
}
