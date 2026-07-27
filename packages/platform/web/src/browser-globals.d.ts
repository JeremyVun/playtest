type WebDynamic = any; // SAFETY: Hosted web inputs are unvalidated API payloads and heterogeneous DOM content.

interface ParentNode {
  querySelector(selectors: string): WebDynamic;
  querySelectorAll(selectors: string): WebDynamic;
}

interface Document {
  getElementById(elementId: string): WebDynamic;
}

interface Element {
  dataset: WebDynamic;
  selectionStart?: WebDynamic;
}
