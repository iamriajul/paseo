import { Nav } from "../nav";

const formStyle = { display: "grid", gap: 8, maxWidth: 320, padding: 16 };

export default function Login() {
  return (
    <main>
      <Nav />
      <h1>Sign in</h1>
      <form method="post" action="/api/login" style={formStyle}>
        <label>
          Username <input name="user" required />
        </label>
        <label>
          Password <input name="password" type="password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
