import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "../nav";

export default async function Dashboard() {
  const session = (await cookies()).get("session")?.value;
  if (!session) redirect("/login");
  return (
    <main>
      <Nav />
      <h1 id="welcome">Welcome, {session.replace("user:", "")}</h1>
      <form method="post" action="/api/logout">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
