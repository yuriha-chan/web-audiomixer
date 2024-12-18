import { atom } from "jotai";
export const isPlaying = atom<boolean>(false);
export const cursorTime = atom<number>(0);
const trackIDs = [crypto.randomUUID(), crypto.randomUUID()];
export const mixerTracks = atom([[trackIDs[0], atom({ id: trackIDs[0], volume: 0.0, clips: [] })], [trackIDs[1], atom({ id: trackIDs[1], volume: 0.0, clips: [] })]]);
export const selectedClip = atom(null);
export const mixerLength = atom(90);
