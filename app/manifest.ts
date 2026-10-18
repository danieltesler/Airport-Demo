import type { MetadataRoute } from "next";

/** Lets "Add to Home screen" open the app full-screen with its own name and colour. No service worker, so nothing is cached. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Airport Investment Intelligence",
    short_name: "Airport Intel",
    description: "Conversational analysis assistant for airport-investment analysts.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f2033",
    theme_color: "#0f2033",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
