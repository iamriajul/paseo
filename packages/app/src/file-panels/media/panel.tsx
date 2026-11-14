import { useEffect, useState } from "react";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useTranslation } from "react-i18next";
import { mediaFormat } from "./formats";
import { MediaMessage } from "./message";
import { MediaPlayer } from "./player";

/** Video and audio: plays the file with seeking, streamed from the host. */
export function MediaPanel({ file, params, workspaceId, host }: PluginFilePanelProps) {
  const { t } = useTranslation();
  const format = mediaFormat(params.path);
  // A file rewritten on disk plays again from its new bytes.
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      file.watch((event) => {
        if (event.type === "changed") setVersion((current) => current + 1);
      }),
    [file],
  );
  if (!format) return <MediaMessage message={t("panels.file.media.unsupported")} tone="error" />;
  return (
    <MediaPlayer
      key={version}
      format={format}
      size={file.size}
      serverId={host.id}
      workspaceId={workspaceId}
      path={params.path}
      file={file}
      label={file.name}
    />
  );
}
