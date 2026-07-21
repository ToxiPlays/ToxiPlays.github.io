/* ===================================================================
   Genius Forum Simulator — app.js
=================================================================== */

const DEFAULT_AVATAR = "https://assets.genius.com/images/default_cover_image.png?1784230759";

const ROLES = {
  contributor:     { label: "Contributor",     className: "contributor" },
  verified_artist: { label: "Verified Artist", className: "verified_artist" },
  transcriber:     { label: "Transcriber",     className: "transcriber" },
  editor:          { label: "Editor",          className: "editor" },
  mediator:        { label: "Mediator",        className: "mediator" },
  moderator:       { label: "Moderator",       className: "moderator" },
  staff:           { label: "Staff",           className: "staff" },
};

const ROLE_ICON_SHAPES = {
  contributor:     `<polygon points="5,1 10,9 0,9"></polygon>`,
  verified_artist: `<circle cx="5" cy="5" r="5"></circle><path stroke-width="0.25" fill="#000" d="M4.43 7 2.25 4.968l.509-.546 1.634 1.524L7.136 3l.546.509L4.43 7Z"></path>`,
  transcriber:     `<rect x="1" y="1" width="8" height="8"></rect>`,
  editor:          `<path d="m5 0 1.43 3.1.1.23.25.04 3.22.46-2.33 2.35-.19.2.05.26L8.1 10 5.21 8.38 5 8.26l-.21.12L1.89 10l.58-3.36.05-.27-.19-.19L0 3.83l3.22-.46.24-.04.11-.24Z"></path>`,
  mediator:        `<rect x="1" y="1" width="8" height="8"></rect>`,
  moderator:       `<polygon points="5,0 10,5 5,10 0,5"></polygon>`,
  staff:           `<circle cx="5" cy="5" r="5"></circle>`,
};

const ROLE_ICON_MIN_IQ = 600;

function roleIconHtml(user, roleInfo) {
  const iq = Number(user.iq) || 0;
  if (iq < ROLE_ICON_MIN_IQ && roleInfo.className === "contributor") return ""; // Contributors with <300IQ should have no role icon
  const shape = ROLE_ICON_SHAPES[roleInfo.className];
  if (!shape) return "";
  return `<span class="user_badge-role_icon user_badge-role_icon--${roleInfo.className}"><svg viewBox="0 0 10 10">${shape}</svg></span>`;
}

let uidCounter = 1;
function newId(prefix) { return prefix + "_" + (uidCounter++) + "_" + Math.random().toString(36).slice(2, 7); }

function defaultState() {
  return {
    users: [
      { id: "u_default", name: "Test", role: "contributor", iq: 0, avatar: DEFAULT_AVATAR }
    ],
    post: {
      title: "Title",
      userId: "u_default",
      votes: "",
      body: "Hello world!",
      timeAgo: "just now"
    },
    replies: []
  };
}

let state = defaultState();

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getUser(userId) {
  return state.users.find(u => u.id === userId) || null;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function formatIq(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-US");
}

function getTimeAgoText(value) {
  const text = value == null ? "" : String(value).trim();
  return text || "just now";
}

function markdownToSafeHtml(raw) {
  const text = raw || "";
  let html;
  try {
    html = marked.parse(text, { breaks: true });
  } catch (e) {
    html = escapeHtml(text);
  }
  if (window.DOMPurify) {
    html = DOMPurify.sanitize(html);
  }
  return html;
}

function formatCompactVote(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  if (num === 0) return "";

  const abs = Math.abs(num);
  let sign = num < 0 ? "-" : "+";

  if (abs >= 1000000000) {
    const value = abs / 1000000000;
    const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return `${sign}${formatted}B`;
  }
  if (abs >= 1000000) {
    const value = abs / 1000000;
    const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return `${sign}${formatted}M`;
  }
  if (abs >= 1000) {
    const value = abs / 1000;
    const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return `${sign}${formatted}K`;
  }

  if (sign === "-") { sign = "" }

  return `${sign}${Math.trunc(num)}`;
}

function voteBadgeHtml(votes) {
  if (votes === "" || votes === null || votes === undefined) return "";
  const n = Number(votes);
  if (Number.isNaN(n) || n === 0) return "";
  const text = formatCompactVote(n);
  if (n > 0) return `<span class="votes_total upvote">${text}</span>`;
  return `<span class="votes_total downvote">${text}</span>`;
}

function userBadgeHtml(user) {
  if (!user) {
    return `
      <div class="user_badge unknown_user">
        <div class="badge_avatar_wrapper">
          <img class="avatar" src="${DEFAULT_AVATAR}" alt="">
        </div>
        <div class="user_details">
          <span class="login">[deleted user]</span>
          <div class="checky"></div>
          <p class="iq"><span class="iq_value">0</span></p>
        </div>
      </div>`;
  }
  const roleInfo = ROLES[user.role] || ROLES.contributor;
  const badgeClass = roleInfo.className === "contributor" ? "user_badge contributor" : `user_badge ${roleInfo.className}`;
  return `
    <div class="${badgeClass}">
      <div class="badge_avatar_wrapper">
        <img class="avatar" src="${escapeHtml(user.avatar || DEFAULT_AVATAR)}" alt="${escapeHtml(user.name)}" onerror="this.src='${DEFAULT_AVATAR}'">
      </div>
      <div class="user_details">
        <span class="login">${escapeHtml(user.name)}</span>
        ${roleIconHtml(user, roleInfo)}
        <p class="iq"><span class="iq_value">${formatIq(user.iq)}</span></p>
      </div>
    </div>`;
}

function postUnitHtml({ user, body, votes, isFirst, replyId, timeAgo }) {
  return `
    <div class="forum_post_unit" ${replyId ? `data-reply-id="${replyId}"` : `data-op="1"`}>
      <div class="forum_post-header">
        <div class="name">
          ${userBadgeHtml(user)}
        </div>
        <div class="voting_links">
          <a class="vote up" tabindex="-1">Upvote</a>
          ${voteBadgeHtml(votes)}
          <a class="vote down" tabindex="-1">Downvote</a>
        </div>
      </div>
      <div class="body">${markdownToSafeHtml(body)}</div>
      <div class="meta">
        <span class="timeago">${escapeHtml(getTimeAgoText(timeAgo))}</span>
        ${replyId ? `<a class="destroy" data-delete-reply="${replyId}">Delete</a>` : ``}
      </div>
    </div>`;
}

// ------------------------------------------------------------------
// Rendering: discussion (left column)
// ------------------------------------------------------------------

function renderDiscussion() {
  document.getElementById("disc_title").textContent = state.post.title || "Title";

  const badge = voteBadgeHtml(state.post.votes); // "" or a <span class="votes_total ...">±N</span>
  const voteClass = badge.includes("downvote") ? "votes_total downvote" : (badge.includes("upvote") ? "votes_total upvote" : "votes_total");
  const voteText = badge ? badge.replace(/<[^>]+>/g, "") : "";
  const discVotesEl = document.getElementById("disc_votes");
  discVotesEl.className = voteClass;
  discVotesEl.textContent = voteText;

  const container = document.getElementById("forum_post_container");
  let html = postUnitHtml({
    user: getUser(state.post.userId),
    body: state.post.body,
    votes: state.post.votes,
    isFirst: true,
    timeAgo: state.post.timeAgo
  });

  state.replies.forEach(r => {
    html += postUnitHtml({
      user: getUser(r.userId),
      body: r.body,
      votes: r.votes,
      replyId: r.id,
      timeAgo: r.timeAgo
    });
  });

  container.innerHTML = html;

  container.querySelectorAll("[data-delete-reply]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-delete-reply");
      if (confirm("Delete this reply?")) {
        state.replies = state.replies.filter(r => r.id !== id);
        renderAll();
      }
    });
  });
}

// ------------------------------------------------------------------
// Rendering: Users tab
// ------------------------------------------------------------------

function usageCount(userId) {
  let count = state.post.userId === userId ? 1 : 0;
  count += state.replies.filter(r => r.userId === userId).length;
  return count;
}

function renderUsersTab() {
  const list = document.getElementById("user_list");
  if (state.users.length === 0) {
    list.innerHTML = `<div class="empty_state">No users yet — add one above.</div>`;
    return;
  }
  list.innerHTML = state.users.map(u => {
    const roleInfo = ROLES[u.role] || ROLES.contributor;
    const check = roleIconHtml(u, roleInfo);
    return `
      <div class="user_row" data-user-id="${u.id}">
        <img class="avatar" src="${escapeHtml(u.avatar || DEFAULT_AVATAR)}" onerror="this.src='${DEFAULT_AVATAR}'">
        <div class="user_row-info">
          <div class="user_row-name">${escapeHtml(u.name)} ${check}</div>
          <div class="user_row-meta">${roleInfo.label} · IQ ${formatIq(u.iq)}</div>
        </div>
        <div class="user_row-actions">
          <button data-edit-user="${u.id}">Edit</button>
          <button data-delete-user="${u.id}">Delete</button>
        </div>
      </div>`;
  }).join("");

  list.querySelectorAll("[data-edit-user]").forEach(btn => {
    btn.addEventListener("click", () => openUserModal(btn.getAttribute("data-edit-user")));
  });
  list.querySelectorAll("[data-delete-user]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-delete-user");
      const uses = usageCount(id);
      const msg = uses > 0
        ? `This user is referenced by ${uses} post(s)/reply(ies), which will show as "[deleted user]". Delete anyway?`
        : "Delete this user?";
      if (confirm(msg)) {
        state.users = state.users.filter(u => u.id !== id);
        renderAll();
      }
    });
  });
}

// ------------------------------------------------------------------
// Rendering: Posts tab (dropdown population + reply list)
// ------------------------------------------------------------------

function populateUserSelect(selectEl, selectedId) {
  if (state.users.length === 0) {
    selectEl.innerHTML = `<option value="">— no users —</option>`;
    return;
  }
  selectEl.innerHTML = state.users.map(u =>
    `<option value="${u.id}" ${u.id === selectedId ? "selected" : ""}>${escapeHtml(u.name)}</option>`
  ).join("");
}

function renderPostsTab() {
  document.getElementById("post_title").value = state.post.title;
  document.getElementById("post_votes").value = state.post.votes;
  document.getElementById("post_body").value = state.post.body;
  document.getElementById("post_time_ago").value = getTimeAgoText(state.post.timeAgo);
  populateUserSelect(document.getElementById("post_user"), state.post.userId);

  const replyList = document.getElementById("reply_list");
  if (state.replies.length === 0) {
    replyList.innerHTML = `<div class="empty_state">No replies yet.</div>`;
    return;
  }
  replyList.innerHTML = state.replies.map(r => {
    const user = getUser(r.userId);
    const name = user ? escapeHtml(user.name) : "[deleted user]";
    return `
      <div class="reply_row" data-reply-id="${r.id}">
        <div class="reply_row-top">
          <span class="reply_row-name">${name}</span>
          <div class="reply_row-actions">
            <button data-edit-reply="${r.id}">Edit</button>
            <button data-delete-reply-row="${r.id}">Delete</button>
          </div>
        </div>
        <div class="reply_row-body">${escapeHtml((r.body || "").slice(0, 120))}</div>
      </div>`;
  }).join("");

  replyList.querySelectorAll("[data-edit-reply]").forEach(btn => {
    btn.addEventListener("click", () => openReplyModal(btn.getAttribute("data-edit-reply")));
  });
  replyList.querySelectorAll("[data-delete-reply-row]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-delete-reply-row");
      if (confirm("Delete this reply?")) {
        state.replies = state.replies.filter(r => r.id !== id);
        renderAll();
      }
    });
  });
}

// ------------------------------------------------------------------
// Master render
// ------------------------------------------------------------------

function renderAll() {
  renderDiscussion();
  renderUsersTab();
  renderPostsTab();
}

// ------------------------------------------------------------------
// Tabs
// ------------------------------------------------------------------

document.querySelectorAll(".tab_btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab_btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab_content").forEach(c => c.hidden = true);
    btn.classList.add("active");
    document.getElementById("tab_" + btn.getAttribute("data-tab")).hidden = false;
  });
});

// ------------------------------------------------------------------
// Posts tab: live-bind fields to state
// ------------------------------------------------------------------

document.getElementById("post_title").addEventListener("input", e => {
  state.post.title = e.target.value;
  renderDiscussion();
});
document.getElementById("post_user").addEventListener("change", e => {
  state.post.userId = e.target.value;
  renderDiscussion();
});
document.getElementById("post_votes").addEventListener("input", e => {
  state.post.votes = e.target.value;
  renderDiscussion();
});
document.getElementById("post_body").addEventListener("input", e => {
  state.post.body = e.target.value;
  renderDiscussion();
});
document.getElementById("post_time_ago").addEventListener("input", e => {
  state.post.timeAgo = e.target.value;
  renderDiscussion();
});

// ------------------------------------------------------------------
// User modal
// ------------------------------------------------------------------

let editingUserId = null;
let pendingAvatarDataUrl = null;

const userModalOverlay = document.getElementById("user_modal_overlay");
const userForm = document.getElementById("user_form");

function openUserModal(userId) {
  editingUserId = userId || null;
  pendingAvatarDataUrl = null;
  document.getElementById("user_avatar_file").value = "";

  if (editingUserId) {
    const u = getUser(editingUserId);
    document.getElementById("user_modal_title").textContent = "Edit user";
    document.getElementById("user_avatar_url").value = (u.avatar && u.avatar !== DEFAULT_AVATAR && !u.avatar.startsWith("data:")) ? u.avatar : "";
    document.getElementById("user_name").value = u.name;
    document.getElementById("user_role").value = u.role;
    document.getElementById("user_iq").value = u.iq;
    if (u.avatar && u.avatar.startsWith("data:")) pendingAvatarDataUrl = u.avatar;
  } else {
    document.getElementById("user_modal_title").textContent = "Add user";
    document.getElementById("user_avatar_url").value = "";
    document.getElementById("user_name").value = "";
    document.getElementById("user_role").value = "contributor";
    document.getElementById("user_iq").value = "0";
  }
  userModalOverlay.hidden = false;
}

function closeUserModal() {
  userModalOverlay.hidden = true;
  editingUserId = null;
  pendingAvatarDataUrl = null;
}

document.getElementById("btn_add_user").addEventListener("click", () => openUserModal(null));
document.getElementById("user_modal_cancel").addEventListener("click", closeUserModal);
userModalOverlay.addEventListener("click", e => { if (e.target === userModalOverlay) closeUserModal(); });

document.getElementById("user_avatar_file").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) { pendingAvatarDataUrl = null; return; }
  const reader = new FileReader();
  reader.onload = () => { pendingAvatarDataUrl = reader.result; };
  reader.readAsDataURL(file);
});

userForm.addEventListener("submit", e => {
  e.preventDefault();
  const name = document.getElementById("user_name").value.trim();
  if (!name) { document.getElementById("user_name").focus(); return; }
  const role = document.getElementById("user_role").value;
  const iqVal = document.getElementById("user_iq").value;
  const iq = iqVal === "" ? 0 : Number(iqVal);
  const urlVal = document.getElementById("user_avatar_url").value.trim();

  let avatar = DEFAULT_AVATAR;
  if (pendingAvatarDataUrl) avatar = pendingAvatarDataUrl;
  else if (urlVal) avatar = urlVal;
  else if (editingUserId) {
    const existing = getUser(editingUserId);
    if (existing && existing.avatar) avatar = existing.avatar;
  }

  if (editingUserId) {
    const u = getUser(editingUserId);
    u.name = name; u.role = role; u.iq = iq; u.avatar = avatar;
  } else {
    state.users.push({ id: newId("u"), name, role, iq, avatar });
  }
  closeUserModal();
  renderAll();
});

// ------------------------------------------------------------------
// Reply modal
// ------------------------------------------------------------------

let editingReplyId = null;
const replyModalOverlay = document.getElementById("reply_modal_overlay");
const replyForm = document.getElementById("reply_form");

function openReplyModal(replyId) {
  editingReplyId = replyId || null;
  populateUserSelect(document.getElementById("reply_user"), editingReplyId ? state.replies.find(r => r.id === editingReplyId).userId : (state.post.userId));

  if (editingReplyId) {
    const r = state.replies.find(rr => rr.id === editingReplyId);
    document.getElementById("reply_modal_title").textContent = "Edit reply";
    document.getElementById("reply_votes").value = r.votes;
    document.getElementById("reply_body").value = r.body;
    document.getElementById("reply_time_ago").value = getTimeAgoText(r.timeAgo);
  } else {
    document.getElementById("reply_modal_title").textContent = "Add reply";
    document.getElementById("reply_votes").value = "";
    document.getElementById("reply_body").value = "";
    document.getElementById("reply_time_ago").value = "just now";
  }
  replyModalOverlay.hidden = false;
}

function closeReplyModal() {
  replyModalOverlay.hidden = true;
  editingReplyId = null;
}

document.getElementById("btn_add_reply").addEventListener("click", () => openReplyModal(null));
document.getElementById("reply_modal_cancel").addEventListener("click", closeReplyModal);
replyModalOverlay.addEventListener("click", e => { if (e.target === replyModalOverlay) closeReplyModal(); });

replyForm.addEventListener("submit", e => {
  e.preventDefault();
  const userId = document.getElementById("reply_user").value;
  const votes = document.getElementById("reply_votes").value;
  const body = document.getElementById("reply_body").value;
  const timeAgo = getTimeAgoText(document.getElementById("reply_time_ago").value);

  if (editingReplyId) {
    const r = state.replies.find(rr => rr.id === editingReplyId);
    r.userId = userId; r.votes = votes; r.body = body; r.timeAgo = timeAgo;
  } else {
    state.replies.push({ id: newId("r"), userId, votes, body, timeAgo });
  }
  closeReplyModal();
  renderAll();
});

// ------------------------------------------------------------------
// Settings tab
// ------------------------------------------------------------------

document.getElementById("btn_save_gfw").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "discussion.gfw";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById("btn_load_gfw").addEventListener("click", () => {
  document.getElementById("file_load_gfw").click();
});

document.getElementById("file_load_gfw").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.users || !parsed.post) throw new Error("Invalid file structure");
      state = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        post: {
          title: parsed.post.title ?? "Title",
          userId: parsed.post.userId ?? null,
          votes: parsed.post.votes ?? "",
          body: parsed.post.body ?? "",
          timeAgo: getTimeAgoText(parsed.post.timeAgo)
        },
        replies: Array.isArray(parsed.replies) ? parsed.replies : []
      };
      renderAll();
    } catch (err) {
      alert("Couldn't load that file — it doesn't look like a valid .gfw file.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

document.getElementById("btn_reset").addEventListener("click", () => {
  if (confirm("Reset the tool? This clears all users, posts, and replies you've created.")) {
    state = defaultState();
    renderAll();
  }
});

// -------- export as image --------

function setExportStatus(msg) {
  document.getElementById("export_status").textContent = msg;
}

async function captureDiscussion() {
  setExportStatus("Rendering image…");
  const target = document.getElementById("group_discussion");
  const canvas = await html2canvas(target, {
    backgroundColor: "#000000",
    scale: 2,
    useCORS: true
  });
  return canvas;
}

document.getElementById("btn_copy_image").addEventListener("click", async () => {
  try {
    const canvas = await captureDiscussion();
    canvas.toBlob(async blob => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setExportStatus("Copied to clipboard!");
      } catch (err) {
        setExportStatus("Clipboard copy failed (your browser may not support it). Try 'Save image to disk' instead.");
      }
    }, "image/png");
  } catch (err) {
    setExportStatus("Couldn't render image: " + err.message);
  }
});

document.getElementById("btn_download_image").addEventListener("click", async () => {
  try {
    const canvas = await captureDiscussion();
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "genius-discussion.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportStatus("Image saved!");
    }, "image/png");
  } catch (err) {
    setExportStatus("Couldn't render image: " + err.message);
  }
});

renderAll();
