import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { BacklogScreen } from "@/screens/backlog-screen";

export default function BacklogRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    projectId?: string;
    name?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const screenKey = JSON.stringify([serverId, projectId, displayName ?? null]);

  return (
    <HostRouteBootstrapBoundary>
      <BacklogScreen
        key={screenKey}
        serverId={serverId}
        projectId={projectId}
        displayName={displayName}
      />
    </HostRouteBootstrapBoundary>
  );
}
