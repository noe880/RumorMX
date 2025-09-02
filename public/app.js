let map;
let markers = [];
let infoWindow;
let currentDetailMarker = null;

// Limites aproximados de México (para restringir el viewport)
const MEXICO_BOUNDS = {
  north: 33.0,
  south: 14.0,
  west: -118.5,
  east: -86.5,
};

window.addEventListener("load", async () => {
  await initMap();
  setupTopPanel();
});

async function initMap() {
  const center = { lat: 23.6345, lng: -102.5528 };

  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  // Crear mapa full-screen
  map = new Map(document.getElementById("map"), {
    center,
    zoom: 5,
    mapId: "DEMO_MAP_ID",
    restriction: {
      latLngBounds: MEXICO_BOUNDS,
      strictBounds: true,
    },
    // UI minimalista
    fullscreenControl: false,
    streetViewControl: false,
    mapTypeControl: false,
    gestureHandling: "greedy",
  });

  // Limitar el panning fuera de México (seguridad extra)
  map.addListener("dragend", () => {
    const c = map.getCenter();
    const lat = Math.min(
      Math.max(c.lat(), MEXICO_BOUNDS.south),
      MEXICO_BOUNDS.north
    );
    const lng = Math.min(
      Math.max(c.lng(), MEXICO_BOUNDS.west),
      MEXICO_BOUNDS.east
    );
    if (lat !== c.lat() || lng !== c.lng()) map.setCenter({ lat, lng });
  });

  infoWindow = new google.maps.InfoWindow();

  await loadHouses();
  // precargar top si se desea al abrir panel (no visible hasta click)
  preloadTopNotes();

  // Actualizar visibilidad con movimiento/zoom
  map.addListener("idle", updateMarkersVisibility);
  map.addListener("zoom_changed", updateMarkersVisibility);

  // cerrar panel si se hace click en el mapa (opcional)
  const panel = document.getElementById("side-panel");
  if (panel) panel.classList.remove("open");

  // Crear nueva nota con click (solo si estás dentro del radio desde el centro)
  map.addListener("click", (event) => {
    const pos = event.latLng;
    const center = map.getCenter();
    const dist = haversineMeters(
      center.lat(),
      center.lng(),
      pos.lat(),
      pos.lng()
    );
    if (dist > PROXIMITY_RADIUS_METERS) {
      //alert("Debes acercarte más para agregar una nota en ese lugar.");
      return;
    }
    openCreateForm(pos);
  });
}

function createMarker(position, address, description, id = null) {
  // Chip visual para el marcador
  const chip = document.createElement("div");
  chip.className = "marker-chip";
  const emoji = document.createElement("span");
  emoji.className = "emoji";
  emoji.textContent = "🏠";
  const text = document.createElement("span");
  text.textContent = address ? trimText(address, 18) : "Nueva nota";
  chip.appendChild(emoji);
  chip.appendChild(text);

  const marker = new google.maps.marker.AdvancedMarkerElement({
    map,
    position,
    content: chip,
  });

  marker.address = address;
  marker.description = description;
  marker.id = id;

  // Guardamos la lat/lng como números para calcular distancias
  marker.lat =
    typeof position.lat === "function" ? position.lat() : position.lat;
  marker.lng =
    typeof position.lng === "function" ? position.lng() : position.lng;

  marker.addListener("click", () => {
    currentDetailMarker = marker;
    openDetail(marker);
  });

  return marker;
}

async function loadHouses() {
  try {
    const response = await fetch("/api/houses");
    const houses = await response.json();

    houses.forEach((house) => {
      const position = new google.maps.LatLng(house.lat, house.lng);
      const marker = createMarker(
        position,
        house.address,
        house.description,
        house.id
      );
      markers.push(marker);
    });

    // Ajustar visibilidad inicial
    updateMarkersVisibility();
  } catch (error) {
    console.error("Error loading houses:", error);
  }
}

function openDetail(marker) {
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">${escapeHtml(marker.address || "Sin dirección")}</div>
    <div class="desc">${escapeHtml(
      marker.description || "Sin descripción"
    )}</div>

    <div class="house-reactions-section" style="margin: 10px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb;">
      <div class="house-reactions" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
    </div>

    <div class="comments-section">
      <div class="comments-title"><strong>Comentarios</strong></div>
      <div class="comments-list"></div>
      <div class="comment-form quick-form" style="padding: 10px;">
      <br>
        <input id="comment-input" type="text" placeholder="Escribe un comentario..." maxlength="500" />
        <div class="actions">
          <button class="primary" id="comment-submit">Comentar</button>
        </div>
      </div>
    </div>
  `;

  infoWindow.setContent(content);
  infoWindow.setPosition(marker.position);

  // Mostrar un poco más arriba (hacia arriba = valor negativo en Y)
  infoWindow.setOptions({
    pixelOffset: new google.maps.Size(0, -30),
  });

  infoWindow.open({ map });

  // Si no hay ID, no se pueden cargar/enviar comentarios ni reacciones
  if (!marker.id) return;

  // Load house reactions
  loadHouseReactions(marker.id, content);

  const listEl = content.querySelector(".comments-list");
  const inputEl = content.querySelector("#comment-input");
  const submitEl = content.querySelector("#comment-submit");

  const renderComments = (comments) => {
    if (!Array.isArray(comments) || comments.length === 0) {
      listEl.innerHTML =
        '<div class="comment-empty" style="color:#6b7280;font-size:13px;">Sé el primero en comentar</div>';
      return;
    }
    listEl.innerHTML = "";
    comments.forEach((c) => {
      const item = document.createElement("div");
      item.className = "comment-item";
      const when = c.created_at ? new Date(c.created_at).toLocaleString() : "";

      // Build HTML (text + meta only, reactions removed)
      item.innerHTML = `
        <div class="comment-text" style="white-space:pre-wrap;line-height:1.4;font-size:14px;">👤${escapeHtml(
          c.comment || ""
        )}</div>
        <div class="comment-meta" style="color:#9ca3af;font-size:12px;margin-top:2px;">${escapeHtml(
          when
        )}</div>
      `;

      listEl.appendChild(item);
    });
  };

  const loadComments = async () => {
    try {
      listEl.innerHTML =
        '<div style="color:#6b7280;font-size:13px;">Cargando comentarios...</div>';
      const resp = await fetch(`/api/houses/${marker.id}/comments`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      renderComments(data);
    } catch (e) {
      console.error("Error cargando comentarios:", e);
      listEl.innerHTML =
        '<div style="color:#ef4444;font-size:13px;">No se pudieron cargar los comentarios</div>';
    }
  };

  submitEl.addEventListener("click", async () => {
    const txt = (inputEl.value || "").trim();
    if (!txt) return;
    try {
      submitEl.disabled = true;
      const resp = await fetch(`/api/houses/${marker.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: txt }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      inputEl.value = "";
      await loadComments();
    } catch (e) {
      console.error("Error enviando comentario:", e);
      alert("No se pudo enviar el comentario");
    } finally {
      submitEl.disabled = false;
    }
  });

  loadComments();
}

async function loadHouseReactions(houseId, content) {
  try {
    const resp = await fetch(`/api/houses/${houseId}/reactions`);
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();

    renderHouseReactions(data, content, houseId);
  } catch (e) {
    console.error("Error cargando reacciones de casa:", e);
  }
}

function renderHouseReactions(data, content, houseId) {
  const reactionsContainer = content.querySelector(".house-reactions");
  if (!reactionsContainer) return;

  // Reactions mapping (icon + label)
  const REACTIONS = ["like", "love", "haha", "wow", "sad", "angry"];
  const ICON = {
    like: "👍",
    love: "❤️",
    haha: "😄",
    wow: "😮",
    sad: "😢",
    angry: "😡",
  };

  reactionsContainer.innerHTML = "";
  REACTIONS.forEach((r) => {
    const cnt =
      data.reactions && typeof data.reactions[r] === "number"
        ? data.reactions[r]
        : 0;
    const active = data.user_reaction === r ? "active" : "";
    const btn = document.createElement("button");
    btn.className = `react-btn ${active}`;
    btn.setAttribute("data-reaction", r);
    btn.style.cssText =
      "cursor:pointer; padding:4px 8px; border-radius:12px; border:1px solid #e5e7eb; background:#fff; font-size:14px;";
    btn.innerHTML = `${ICON[r]} <span class="cnt">${cnt}</span>`;

    // Style for active button
    if (active) {
      btn.style.background = "#e0f2fe";
      btn.style.borderColor = "#93c5fd";
    }

    btn.addEventListener("click", async () => {
      const reaction = btn.getAttribute("data-reaction");
      try {
        btn.disabled = true;
        let resp;
        if (data.user_reaction === reaction) {
          // toggle off -> DELETE
          resp = await fetch(`/api/houses/${houseId}/reactions`, {
            method: "DELETE",
          });
        } else {
          // set/update -> POST
          resp = await fetch(`/api/houses/${houseId}/reactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reaction }),
          });
        }
        if (!resp.ok) throw new Error(await resp.text());
        const newData = await resp.json();

        // Update local state and re-render
        data.reactions = newData.reactions || data.reactions || {};
        data.user_reaction =
          newData.user_reaction ?? data.user_reaction ?? null;
        renderHouseReactions(data, content, houseId);
      } catch (e) {
        console.error("Error al reaccionar:", e);
        alert("No se pudo registrar la reacción");
      } finally {
        btn.disabled = false;
      }
    });

    reactionsContainer.appendChild(btn);
  });
}

function openCreateForm(position) {
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">Nueva nota</div>
    <div class="quick-form large" style="padding: 4px;">
      <input id="addr" type="text" placeholder="Título" maxlength="70" />
      <textarea id="desc" placeholder="Descripción"></textarea>
      <div class="actions">
        <button class="primary" id="save">Guardar</button>
      </div>
    </div>
  `;

  infoWindow.setContent(content);
  infoWindow.setPosition(position);
  infoWindow.open({ map });

  // Auto-expand del textarea para evitar scroll
  const descEl = content.querySelector("#desc");
  const autoResize = (el) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };
  descEl.addEventListener("input", () => autoResize(descEl));
  // inicializar por si hay texto pegado
  setTimeout(() => autoResize(descEl), 0);

  content.querySelector("#save").addEventListener("click", async () => {
    const address = content.querySelector("#addr").value.trim();
    const description = content.querySelector("#desc").value.trim();
    if (!address || !description) return;

    try {
      const houseData = {
        address,
        description,
        lat: position.lat(),
        lng: position.lng(),
      };

      const resp = await fetch("/api/houses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(houseData),
      });

      if (!resp.ok) throw new Error(await resp.text());
      const newHouse = await resp.json();

      const marker = createMarker(position, address, description, newHouse.id);
      markers.push(marker);
      // Centrar al nuevo marcador y actualizar visibilidad
      map.setCenter(position);
      updateMarkersVisibility();
      openDetail(marker);
    } catch (e) {
      console.error("Error saving house:", e);
    }
  });
}

function openEditForm(marker) {
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">Editar nota</div>
    <div class="meta">Lat: ${formatCoord(
      marker.position.lat
    )} · Lng: ${formatCoord(marker.position.lng)}</div>
    <div class="quick-form">
      <input id="addr" type="text" value="${escapeAttr(
        marker.address || ""
      )}" />
      <textarea id="desc">${escapeHtml(marker.description || "")}</textarea>
      <div class="actions">
        <button class="primary" id="update">Actualizar</button>
      </div>
    </div>
  `;

  infoWindow.setContent(content);
  infoWindow.setPosition(marker.position);
  infoWindow.open({ map });

  content.querySelector("#update").addEventListener("click", async () => {
    const address = content.querySelector("#addr").value.trim();
    const description = content.querySelector("#desc").value.trim();
    if (!address || !description) return;

    try {
      const resp = await fetch(`/api/houses/${marker.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, description }),
      });
      if (!resp.ok) throw new Error(await resp.text());

      marker.address = address;
      marker.description = description;
      openDetail(marker);
    } catch (e) {
      console.error("Error updating house:", e);
    }
  });
}

async function deleteHouse(id) {
  if (!id) return;
  if (!confirm("¿Eliminar esta nota?")) return;

  try {
    const resp = await fetch(`/api/houses/${id}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(await resp.text());

    const idx = markers.findIndex((m) => m.id === id);
    if (idx !== -1) {
      markers[idx].map = null; // remove from map
      markers.splice(idx, 1);
    }
    infoWindow.close();
  } catch (e) {
    console.error("Error deleting house:", e);
  }
}

// Configuración de proximidad (en metros)
const PROXIMITY_RADIUS_METERS = 3000; // 3 km por defecto, ajústalo si quieres más/menos

// Helpers
function trimText(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
function formatCoord(fn) {
  // supports both number and function lat()/lng()
  const v = typeof fn === "function" ? fn() : fn;
  return Number(v).toFixed(4);
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// Distancia Haversine (metros)
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // radio tierra en m
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Actualiza visibilidad de marcadores según distancia al centro del mapa
function updateMarkersVisibility() {
  if (!map) return;
  const center = map.getCenter();
  const cLat = center.lat();
  const cLng = center.lng();

  // Cerrar detalle si el marcador activo sale de rango
  let shouldCloseInfo = false;

  markers.forEach((m) => {
    const dist = haversineMeters(cLat, cLng, m.lat, m.lng);
    const visible = dist <= PROXIMITY_RADIUS_METERS;

    // Mostrar/ocultar AdvancedMarkerElement
    m.map = visible ? map : null;

    if (!visible && currentDetailMarker && m === currentDetailMarker) {
      shouldCloseInfo = true;
    }
  });

  if (shouldCloseInfo) {
    infoWindow.close();
    currentDetailMarker = null;
  }
}

// -------- Top 5 Lógica --------
let cachedTop = [];
let topLoadedOnce = false;

async function fetchTopNotes() {
  const resp = await fetch("/api/houses/top?limit=5");
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  cachedTop = Array.isArray(data) ? data : [];
  topLoadedOnce = true;
  return cachedTop;
}

function renderTopList(list) {
  const container = document.getElementById("top-list");
  if (!container) return;
  if (!list || list.length === 0) {
    container.innerHTML =
      '<div style="padding:12px;color:#6b7280;font-size:13px;">Sin datos</div>';
    return;
  }
  container.innerHTML = "";
  list.slice(0, 5).forEach((item, idx) => {
    const el = document.createElement("div");
    el.className = "top-item";
    el.innerHTML = `
      <div class="top-rank">${idx + 1}</div>
      <div class="top-content">
        <div class="top-title">${escapeHtml(item.address || "Sin título")}</div>
        <div class="top-desc">${escapeHtml(item.description || "")}</div>
        <div class="top-meta">💬 ${item.comment_count || 0} comentarios</div>
      </div>
    `;
    el.addEventListener("click", () => {
      // Buscar el marcador existente por id
      const marker = markers.find((m) => m.id === item.id);
      if (marker) {
        const pos = new google.maps.LatLng(marker.lat, marker.lng);
        map.setCenter(pos);
        map.setZoom(17);
        openDetail(marker);
      } else {
        // Si por alguna razón no está cargado, crear uno temporal
        const position = new google.maps.LatLng(item.lat, item.lng);
        const tempMarker = createMarker(
          position,
          item.address,
          item.description,
          item.id
        );
        markers.push(tempMarker);
        map.setCenter(position);
        map.setZoom(17);
        openDetail(tempMarker);
      }
      // Cerrar panel Top 5 al seleccionar
      const panel = document.getElementById("side-panel");
      if (panel) panel.classList.remove("open");
    });
    container.appendChild(el);
  });
}

function setupTopPanel() {
  const btn = document.getElementById("menu-button");
  const panel = document.getElementById("side-panel");
  if (!btn || !panel) return;

  const closePanel = () => panel.classList.remove("open");

  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const opening = !panel.classList.contains("open");
    if (opening) {
      panel.classList.add("open");
      try {
        if (!topLoadedOnce) await fetchTopNotes();
        renderTopList(cachedTop);
      } catch (e) {
        console.error("Error cargando Top 5:", e);
        const container = document.getElementById("top-list");
        if (container)
          container.innerHTML =
            '<div style="padding:12px;color:#ef4444;font-size:13px;">No se pudo cargar el Top 5</div>';
      }
    } else {
      closePanel();
    }
  });

  // Cerrar al hacer clic fuera del panel
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("open")) return;
    const clickInsidePanel = panel.contains(e.target);
    const clickOnButton = btn.contains(e.target);
    if (!clickInsidePanel && !clickOnButton) {
      closePanel();
    }
  });

  // Cerrar con Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePanel();
    }
  });
}

function preloadTopNotes() {
  // Pre-carga silenciosa, pero no abre ni renderiza hasta click
  fetchTopNotes().catch(() => {});
}

// Manejo de error de Google Maps API
window.gm_authFailure = function () {
  alert("Error al cargar Google Maps. Verifique su clave API.");
};
