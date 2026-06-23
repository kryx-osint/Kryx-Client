(function () {
  "use strict";

  var editModal = document.getElementById("client-team-edit-modal");
  var deleteModal = document.getElementById("client-team-delete-modal");

  function anyModalOpen() {
    return (
      (editModal && !editModal.hidden) ||
      (deleteModal && !deleteModal.hidden)
    );
  }

  function syncBodyClass() {
    document.body.classList.toggle("admin-modal-open", anyModalOpen());
  }

  function closeEditModal() {
    if (!editModal) return;
    editModal.hidden = true;
    syncBodyClass();
  }

  function closeDeleteModal() {
    if (!deleteModal) return;
    deleteModal.hidden = true;
    syncBodyClass();
  }

  function openEditModal(data) {
    if (!editModal) return;
    var idInput = document.getElementById("client-team-edit-id");
    var usernameInput = document.getElementById("client-team-edit-username");
    var displayInput = document.getElementById("client-team-edit-display");
    var passwordInput = document.getElementById("client-team-edit-password");
    var activeInput = document.getElementById("client-team-edit-active");
    var roleInput = document.getElementById("client-team-edit-role");
    var searchEnabledInput = document.getElementById("client-team-edit-search-enabled");
    var mustChangeInput = document.getElementById("client-team-edit-must-change");
    var subtitle = document.getElementById("client-team-edit-subtitle");
    if (idInput) idInput.value = data.id || "";
    if (usernameInput) usernameInput.value = data.username || "";
    if (displayInput) displayInput.value = data.displayName || data.username || "";
    if (passwordInput) passwordInput.value = "";
    if (activeInput) activeInput.checked = data.active === "1";
    if (roleInput) roleInput.value = data.role || "investigator";
    if (searchEnabledInput) searchEnabledInput.checked = data.searchEnabled !== "0";
    if (mustChangeInput) mustChangeInput.checked = false;
    if (subtitle) {
      subtitle.textContent = data.username ? "Member: " + data.username : "";
    }
    editModal.hidden = false;
    syncBodyClass();
    if (displayInput) displayInput.focus();
  }

  function openDeleteModal(data) {
    if (!deleteModal) return;
    var idInput = document.getElementById("client-team-delete-id");
    var message = document.getElementById("client-team-delete-message");
    if (idInput) idInput.value = data.id || "";
    if (message) {
      message.textContent =
        "This removes " +
        (data.username || "this member") +
        " from the workspace. They will no longer be able to sign in. This cannot be undone.";
    }
    deleteModal.hidden = false;
    syncBodyClass();
  }

  document.querySelectorAll("[data-team-edit-open]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      openEditModal({
        id: btn.getAttribute("data-member-id") || "",
        username: btn.getAttribute("data-username") || "",
        displayName: btn.getAttribute("data-display-name") || "",
        active: btn.getAttribute("data-active") || "0",
        role: btn.getAttribute("data-role") || "investigator",
        searchEnabled: btn.getAttribute("data-search-enabled") || "1",
      });
    });
  });

  document.querySelectorAll("[data-team-delete-open]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      openDeleteModal({
        id: btn.getAttribute("data-member-id") || "",
        username: btn.getAttribute("data-username") || "",
      });
    });
  });

  document.querySelectorAll("[data-team-edit-close]").forEach(function (el) {
    el.addEventListener("click", closeEditModal);
  });

  document.querySelectorAll("[data-team-delete-close]").forEach(function (el) {
    el.addEventListener("click", closeDeleteModal);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (editModal && !editModal.hidden) closeEditModal();
    else if (deleteModal && !deleteModal.hidden) closeDeleteModal();
  });
})();
