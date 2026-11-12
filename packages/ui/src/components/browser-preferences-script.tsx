// These existing localStorage choices cannot be known to a server-rendered document. Run before
// the body paints, not in the downloadable application. Defaults keep their immediate SSR paint;
// other choices reveal the shell only after its client snapshot has replaced the server defaults.
const SCRIPT = `try{const r=document.documentElement;if(localStorage.getItem("hyori-item-layout")==="grid")r.setAttribute("data-local-preferences","");if(localStorage.getItem("hyori-sidebar")==="collapsed")r.setAttribute("data-local-desktop-preferences","");if(localStorage.getItem("hyori-single-key-shortcuts")==="off")r.setAttribute("data-local-shortcuts-off","")}catch{}`;

export function BrowserPreferencesScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
