import { notFound } from "next/navigation";
import { VoicePreview } from "@/components/assistant/VoicePreview";

/** Dev-only visual harness for the voice orb. Not linked anywhere; a 404 in production. */
export default function VoicePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <VoicePreview />;
}
