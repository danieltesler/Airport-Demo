import { describe, expect, it } from "vitest";
import { uploadFilename } from "./audioMime";

describe("uploadFilename", () => {
  it.each([
    ["audio/webm;codecs=opus", "speech.webm"],
    ["audio/mp4", "speech.mp4"],
    ["audio/mp4;codecs=mp4a.40.2", "speech.mp4"],
    ["audio/ogg;codecs=opus", "speech.ogg"],
    ["AUDIO/WEBM", "speech.webm"],
  ])("%s -> %s", (mime, expected) => {
    expect(uploadFilename(mime)).toBe(expected);
  });

  it("falls back to webm for an unknown or missing type", () => {
    expect(uploadFilename("")).toBe("speech.webm");
    expect(uploadFilename(undefined)).toBe("speech.webm");
    expect(uploadFilename("video/x-unknown")).toBe("speech.webm");
  });
});
