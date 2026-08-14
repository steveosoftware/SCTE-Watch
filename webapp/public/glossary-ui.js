// Click-to-modal glossary. Uses event delegation on document so it covers
// .glossary-term spans injected later by app.js/manifest-inspector.js
// without either of them needing to know this module exists.

import { GLOSSARY } from "./glossary.js";

const modal = document.getElementById("glossary-modal");
const modalTerm = document.getElementById("glossary-modal-term");
const modalDef = document.getElementById("glossary-modal-def");
const closeBtn = document.getElementById("glossary-modal-close");

function openGlossary(term) {
  const def = GLOSSARY[term];
  if (!def) return;
  modalTerm.textContent = term;
  modalDef.textContent = def;
  modal.hidden = false;
}

function closeGlossary() {
  modal.hidden = true;
}

document.addEventListener("click", (e) => {
  const term = e.target.closest(".glossary-term");
  if (term) {
    openGlossary(term.dataset.term);
    return;
  }
  if (e.target === modal) closeGlossary();
});

closeBtn.addEventListener("click", closeGlossary);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeGlossary();
});
