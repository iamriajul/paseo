import { Nav } from "../nav";

export default function About() {
  return (
    <main>
      <Nav />
      <h1 id="about-title">About this fixture</h1>
      <p>Loaded by client-side navigation when reached from a Link.</p>
    </main>
  );
}
