// The Office libraries import Node's stream at load time and never call it
// while painting a document. The webview has no Node stream.
export default {};
