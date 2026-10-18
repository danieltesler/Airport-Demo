"use client";

import { useSyncExternalStore } from "react";
import { getSpeechPlayer, type PlaybackSnapshot, type SpeechPlayer } from "@/lib/voicePlayback";

const SERVER_SNAPSHOT: PlaybackSnapshot = { status: "idle", text: null };

/** Live playback state of the page's single speech player. */
export function useSpeechPlayback(): { playback: PlaybackSnapshot; player: SpeechPlayer } {
  const player = getSpeechPlayer();
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot, () => SERVER_SNAPSHOT);
  return { playback, player };
}
