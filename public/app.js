document.addEventListener("DOMContentLoaded", () => {
  setupDropZones();
  setupUploadProgressForms();
  setupNavigationPreloader();
});

function setupDropZones() {
  document.querySelectorAll(".drop-zone").forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    const label = zone.querySelector(".file-name");
    if (!input || !label) return;

    const syncLabel = () => {
      const files = [...(input.files || [])].map((file) => file.name);
      label.textContent = files.length ? files.join(", ") : "No file selected";
    };

    input.addEventListener("change", syncLabel);
    const activate = (event) => {
      event.preventDefault();
      if (hasFiles(event)) zone.classList.add("drag-over", "file-hover");
    };
    const deactivate = () => zone.classList.remove("drag-over", "file-hover");
    zone.addEventListener("dragenter", activate);
    zone.addEventListener("dragover", activate);
    zone.addEventListener("dragleave", (event) => {
      if (!zone.contains(event.relatedTarget)) deactivate();
    });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      deactivate();
      if (!event.dataTransfer?.files?.length) return;
      input.files = event.dataTransfer.files;
      syncLabel();
    });
  });
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function setupUploadProgressForms() {
  document.querySelectorAll("[data-upload-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.XMLHttpRequest || !window.FormData) return;
      if (form.dataset.fallbackSubmit === "1") return;
      event.preventDefault();
      submitWithProgress(form);
    });
  });
}

function submitWithProgress(form) {
  const progress = document.getElementById(form.dataset.progressTarget || "");
  const state = progress ? progressState(progress) : null;
  const xhr = new XMLHttpRequest();
  let processingTimer = null;
  let current = 0;

  const setProgress = (value, message) => {
    current = Math.max(current, Math.min(value, 99));
    state?.set(current, message);
  };

  const beginProcessing = () => {
    clearInterval(processingTimer);
    processingTimer = setInterval(() => {
      const next = current < 90 ? current + 2 : current + 0.4;
      setProgress(next, "Processing file and checking the database.");
    }, 500);
  };

  form.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = "Processing...";
  });

  if (progress) {
    progress.hidden = false;
    progress.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  state?.set(3, "Preparing upload.");

  xhr.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) {
      setProgress(25, "Uploading file.");
      return;
    }
    setProgress(Math.round((event.loaded / event.total) * 70), "Uploading file.");
  });
  xhr.upload.addEventListener("load", () => {
    setProgress(75, "Upload complete. Reading and checking contacts.");
    beginProcessing();
  });
  xhr.addEventListener("load", () => {
    clearInterval(processingTimer);
    if (xhr.status < 200 || xhr.status >= 400) {
      fallbackToNativeUpload(form, state, current, `Upload failed with HTTP ${xhr.status}. Retrying with a standard form upload.`);
      return;
    }
    setProgress(100, "Done.");
    progress?.classList.add("upload-complete");
    document.open();
    document.write(xhr.responseText);
    document.close();
  });
  xhr.addEventListener("error", () => {
    clearInterval(processingTimer);
    fallbackToNativeUpload(form, state, current, "Upload connection failed. Retrying with a standard form upload.");
  });

  xhr.open((form.method || "POST").toUpperCase(), form.getAttribute("action") || window.location.pathname);
  xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
  xhr.send(new FormData(form));
}

function fallbackToNativeUpload(form, state, current, message) {
  state?.set(current || 0, message);
  form.dataset.fallbackSubmit = "1";
  form.querySelectorAll("button").forEach((button) => {
    button.disabled = false;
    button.textContent = button.dataset.originalText || "Submit";
  });
  setTimeout(() => form.submit(), 450);
}

function progressState(progress) {
  const bar = progress.querySelector(".progress-bar");
  const percent = progress.querySelector(".progress-percent");
  const message = progress.querySelector(".progress-message");
  const steps = [...progress.querySelectorAll(".progress-steps span")];

  return {
    set(value, text) {
      const rounded = Math.min(Math.round(value), 100);
      if (bar) bar.style.width = `${rounded}%`;
      if (percent) percent.textContent = `${rounded}%`;
      if (message && text) message.textContent = text;
      const stepIndex = Math.min(Math.floor(rounded / 25), Math.max(steps.length - 1, 0));
      steps.forEach((step, index) => step.classList.toggle("active", index <= stepIndex));
    }
  };
}

function setupNavigationPreloader() {
  const preloader = document.querySelector("[data-page-preloader]");
  if (!preloader) return;
  document.querySelectorAll("[data-show-preloader]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      preloader.hidden = false;
    });
  });
}
