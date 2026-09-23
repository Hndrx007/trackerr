// An error whose message is written for the editor: what happened and what to do next.
// Anything else that reaches the UI is a bug and is shown with its technical detail.
export class UserError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "UserError";
    this.detail = detail;
  }
}

export const isAbort = e => e?.name === "AbortError";
