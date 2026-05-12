document.addEventListener("DOMContentLoaded", () => {
  setupDropZones();
  setupUploadProgressForms();
  setupNavigationPreloader();
  setupAutoHidePreloader();
  setupDelayedRedirects();
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

async function submitWithProgress(form) {
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

  let body;
  let contentType = "";
  try {
    if (hasFileInputs(form)) {
      body = await jsonUploadBody(form, setProgress);
      contentType = "application/json";
    } else {
      body = new FormData(form);
    }
  } catch {
    fallbackToNativeUpload(form, state, current, "Could not read the selected file. Retrying with a standard form upload.");
    return;
  }

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
  if (contentType) xhr.setRequestHeader("Content-Type", contentType);
  xhr.send(body);
}

function hasFileInputs(form) {
  return [...form.querySelectorAll('input[type="file"]')].some((input) => input.files?.length);
}

async function jsonUploadBody(form, setProgress) {
  const payload = { uploadedFiles: [] };
  const fields = new FormData(form);
  for (const [key, value] of fields.entries()) {
    if (value instanceof File) continue;
    payload[key] = value;
  }
  const files = [...form.querySelectorAll('input[type="file"]')].flatMap((input) => [...(input.files || [])]);
  for (const [index, file] of files.entries()) {
    setProgress(5 + Math.round((index / Math.max(files.length, 1)) * 20), `Reading ${file.name}.`);
    payload.uploadedFiles.push({
      name: file.name,
      type: file.type || "",
      data: await readFileAsDataUrl(file)
    });
  }
  setProgress(28, "File ready. Uploading to server.");
  return JSON.stringify(payload);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
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

function setupDelayedRedirects() {
  document.querySelectorAll("[data-delayed-redirect]").forEach((element) => {
    const target = element.dataset.target;
    if (!target) return;
    window.setTimeout(() => {
      window.location.assign(target);
    }, 650);
  });
}

function setupAutoHidePreloader() {
  const preloader = document.querySelector("[data-page-preloader]");
  if (!preloader || preloader.hidden) return;
  const hide = () => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        preloader.hidden = true;
      });
    });
  };
  if (document.readyState === "complete") {
    hide();
    return;
  }
  window.addEventListener("load", hide, { once: true });
}
