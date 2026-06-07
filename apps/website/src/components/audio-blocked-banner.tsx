// AudioBlockedBanner — fixed-position shell-document banner shown whenever the
// LiveKit Room reports `canPlaybackAudio === false`. Mounted at App root so it
// stacks above portal iframes and is reachable regardless of which workspace,
// sidebar collapse state, or panel layout is active.
//
// Why shell-side: the autoplay gate on iOS Safari (and Chrome's stricter
// settings) requires the user gesture that calls `audioContext.resume()` to
// originate in the document that owns the `<audio>` elements — i.e. the shell.
// The voice plugin iframe runs in a sandboxed cross-origin frame; its click
// activation does NOT propagate to the parent on iOS, so a button rendered
// inside the iframe (which posts `platform.voice.start-audio` back) lands in
// the shell's message handler asynchronously, outside any activation window.
// `room.startAudio()` then runs without activation and Safari leaves audio
// blocked. The only reliable unblock path is a click event whose handler is
// attached to a DOM element rendered in the shell document — that's this
// component.
//
// The handler invokes `voiceManager.startAudio()` synchronously: even though
// it's an async function, the synchronous prefix runs the LiveKit
// `room.startAudio()` call inline, which in turn synchronously calls
// `audioContext.resume()` before the first await. That keeps the entire
// resume() invocation within the click's activation window.

import { Show } from "solid-js";
import { Volume2 } from "lucide-solid";
import * as voiceManager from "@/lib/voice-manager";

export function AudioBlockedBanner() {
  return (
    <Show when={voiceManager.state().audioPlaybackBlocked === true}>
      <div class="fixed inset-x-0 top-3 z-[70] flex justify-center px-3 pointer-events-none">
        <button
          type="button"
          class="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 shadow-lg ring-1 ring-amber-500/20 hover:bg-amber-100 active:bg-amber-200 dark:bg-amber-950/90 dark:text-amber-100 dark:hover:bg-amber-900 dark:active:bg-amber-800"
          onClick={() => {
            void voiceManager.startAudio();
          }}
        >
          <Volume2 class="size-4 shrink-0" />
          <span>Tap to enable voice audio</span>
        </button>
      </div>
    </Show>
  );
}
