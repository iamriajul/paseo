declare module "@js-preview/docx" {
  interface OfficeDomPreviewer {
    preview(data: ArrayBuffer): Promise<void>;
    destroy(): void;
  }
  const preview: {
    init(
      host: HTMLElement,
      options: {
        useBase64URL?: boolean;
        inWrapper?: boolean;
        breakPages?: boolean;
      },
    ): OfficeDomPreviewer;
  };
  export default preview;
}

declare module "@js-preview/excel" {
  interface OfficeDomPreviewer {
    preview(data: ArrayBuffer): Promise<void>;
    destroy(): void;
  }
  const preview: {
    init(
      host: HTMLElement,
      options: {
        minColLength?: number;
        showContextmenu?: boolean;
      },
    ): OfficeDomPreviewer;
  };
  export default preview;
}

declare module "pptx-preview" {
  interface OfficeDomPreviewer {
    readonly slideCount: number;
    preview(data: ArrayBuffer): Promise<void>;
    destroy(): void;
  }
  export function init(
    host: HTMLElement,
    options: {
      width: number;
      height: number;
      mode?: "list";
    },
  ): OfficeDomPreviewer;
}
