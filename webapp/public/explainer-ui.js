// "How it works" popups. A panel opts in with a button carrying
// data-explainer="<template id>"; the template's content is cloned into a
// shared modal. Event delegation on document, so a panel adding its own
// explainer later needs no change here.
//
// The content is static markup authored in index.html, never anything
// fetched or user-supplied — the one reason cloning it wholesale is safe
// where the rest of this app escapes everything it renders.

const modal = document.getElementById("explainer-modal");
const titleEl = document.getElementById("explainer-modal-title");
const bodyEl = document.getElementById("explainer-modal-body");
const closeBtn = document.getElementById("explainer-modal-close");

function open(templateId) {
  const tpl = document.getElementById(templateId);
  if (!tpl || !("content" in tpl)) return;
  titleEl.textContent = tpl.dataset.title || "How it works";
  bodyEl.replaceChildren(tpl.content.cloneNode(true));
  bodyEl.scrollTop = 0;
  modal.hidden = false;
  closeBtn.focus();
}

function close() {
  modal.hidden = true;
  // Drop the clone rather than leaving a second copy of the text in the
  // DOM for find-in-page and screen readers to trip over.
  bodyEl.replaceChildren();
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-explainer]");
  if (btn) {
    open(btn.dataset.explainer);
    return;
  }
  if (e.target === modal) close();
});

closeBtn.addEventListener("click", close);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) close();
});
