import {
  encodeBrowserPreferences,
  type BrowserPreferences,
} from "@hyori-cloud/ui/lib/browser-preferences";

// Compare both directions before body paint, including an old cookie after localStorage was
// cleared. Only mismatched surfaces wait. Matching Grid/collapsed documents paint their real SSR.
const SCRIPT = `(()=>{const r=document.documentElement;let l="l",s="o",k="1",f=0;try{l=localStorage.getItem("hyori-item-layout")==="grid"?"g":"l";s=localStorage.getItem("hyori-sidebar")==="collapsed"?"c":"o";k=localStorage.getItem("hyori-single-key-shortcuts")==="off"?"0":"1";f=Math.max(0,["nameAsc","nameDesc","sizeAsc","sizeDesc","modifiedAsc","modifiedDesc"].indexOf(localStorage.getItem("hyori-file-sort")))}catch{}const p=document.querySelector('meta[name="hyori-ui"]')?.content;if(p?.[2]!==l||p?.[8]!==String(f))r.setAttribute("data-local-preferences","");if(p?.[4]!==s)r.setAttribute("data-local-desktop-preferences","");if(p?.[6]!==k)r.setAttribute("data-local-shortcuts-off","");try{document.cookie="hyori_ui=2."+l+"."+s+"."+k+"."+f+"; Path=/; Max-Age=31536000; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"")}catch{}})()`;

export function BrowserPreferencesScript({
  nonce,
  preferences,
}: {
  nonce?: string;
  preferences: BrowserPreferences;
}) {
  return (
    <>
      <meta name="hyori-ui" content={encodeBrowserPreferences(preferences)} />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SCRIPT }} />
    </>
  );
}
