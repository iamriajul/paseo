import type { OfficePreviewKind } from "@/file-explorer/office";

export interface OfficePreviewProps {
  uri: string;
  label: string;
  kind: OfficePreviewKind;
}

export function OfficePreview(props: OfficePreviewProps): React.ReactElement;
