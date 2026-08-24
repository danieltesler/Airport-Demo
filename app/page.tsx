import { AssistantProvider } from "@/components/assistant/AssistantProvider";
import { Thread } from "@/components/assistant/Thread";

/** Single-page chat app, powered by the assistant-ui LocalRuntime. */
export default function HomePage() {
  return (
    <AssistantProvider>
      <Thread />
    </AssistantProvider>
  );
}
