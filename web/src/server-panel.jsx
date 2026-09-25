// server-panel.jsx — compatibility shim. The Server card became the "System"
// section (sections/System.jsx: facts, actions, appearance, integration
// switches, Discord images, log tail); the Meshy key form lives in
// sections/Meshy.jsx and the two-click Stop button in ui.jsx. Nothing in the
// app imports this file any more — it only keeps the old export names alive
// and can be deleted with the other legacy modules at integration.
export { SystemPanel, ServerPanel, DiscordImagesForm } from './sections/System.jsx';
export { MeshyKeyForm } from './sections/Meshy.jsx';
export { StopButton } from './ui.jsx';
