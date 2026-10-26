module.exports = class InputBudget {
  constructor(editor, container, { limit, label, value = "", onValidityChange }) {
    this.editor = editor;
    this.limit = limit;
    this.label = label;
    this.externalValue = value;
    this.onValidityChange = onValidityChange;
    this.element = container.ownerDocument.createElement("div");
    this.element.className = "input-budget-error";
    this.element.setAttribute("role", "status");
    this.element.hidden = true;
    container.appendChild(this.element);
    this.validate(false);
  }

  validate(notify = true) {
    const valid = this.editor.getBuffer().getLength() <= this.limit;
    const message = valid
      ? null
      : `${this.label} exceeds ${this.limit.toLocaleString("en-US")} UTF-16 units. Shorten it before applying.`;
    this.element.textContent = message || "";
    this.element.hidden = valid;
    this.element.classList.toggle("text-error", !valid);
    this.editor.element.setAttribute("aria-invalid", String(!valid));
    const changed = message !== this.message;
    this.message = message;
    if (notify && changed) this.onValidityChange?.(message);
    return valid;
  }

  read() {
    return this.validate() ? this.editor.getText() : undefined;
  }

  sync(value = "", { force = false } = {}) {
    value = value ?? "";
    if (force || value !== this.externalValue) {
      this.externalValue = value;
      const length = this.editor.getBuffer().getLength();
      if (length !== value.length || length > this.limit || this.editor.getText() !== value)
        this.editor.setText(value);
    }
    this.validate();
  }

  dispose() {
    this.element.remove();
    this.editor.element.removeAttribute("aria-invalid");
  }
};
