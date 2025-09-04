let map;
let markers = [];
let emojiMarkers = [];
let clusterMarkers = [];
let popup;
let currentDetailMarker = null;

// Limites aproximados de México (para restringir el viewport)
const MEXICO_BOUNDS = {
  north: 32.7,
  south: 14.5,
  west: -118.4,
  east: -86.7,
};

window.addEventListener("load", async () => {
  await initMap();
  setupTopPanel();
});

// Debounce helper
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

async function initMap() {
  const center = { lat: 23.6345, lng: -102.5528 };

  const token = (window.MAPBOX_TOKEN || "").trim();
  if (!token) {
    alert("Falta el token de Mapbox. Define window.MAPBOX_TOKEN en index.html");
    return;
  }
  mapboxgl.accessToken = token;

  // Crear mapa full-screen con límites de México
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [center.lng, center.lat],
    zoom: 5,
    minZoom: 5,
    maxBounds: [
      [MEXICO_BOUNDS.west, MEXICO_BOUNDS.south], // SW [lng, lat]
      [MEXICO_BOUNDS.east, MEXICO_BOUNDS.north], // NE [lng, lat]
    ],
    bearingSnap: 0,
    pitchWithRotate: false,
  });

  popup = new mapboxgl.Popup({
    closeButton: true,
    closeOnClick: false,
    offset: 28, // separación vertical del marcador
    anchor: "bottom", // siempre mostrar arriba de la nota
  });

  map.on("load", async () => {
    await loadHouses();
    await loadEmojis();
    preloadTopNotes();

    updateMarkersVisibility();
    updateEmojiVisibility();

    const refresh = debounce(async () => {
      await loadHouses();
      await loadEmojis();
      updateMarkersVisibility();
      updateEmojiVisibility();
      applyClustering();
    }, 300);

    map.on("moveend", refresh);
    map.on("zoomend", refresh);

    const panel = document.getElementById("side-panel");
    if (panel) panel.classList.remove("open");
  });

  // Crear nueva nota con click (solo si estás dentro del radio desde el centro)
  map.on("click", (e) => {
    const pos = e.lngLat; // {lng, lat}
    const center = map.getCenter();
    const dist = haversineMeters(center.lat, center.lng, pos.lat, pos.lng);
    if (dist > PROXIMITY_RADIUS_METERS) {
      return;
    }
    openCreateForm({ lat: pos.lat, lng: pos.lng });
  });
}

function createMarker(position, address, description, id = null) {
  // Use canvas-based marker for better performance
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 40;
  canvas.style.cssText = "cursor: pointer;";

  const ctx = canvas.getContext("2d");

  // Draw rounded rectangle background
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 2;
  roundRect(ctx, 2, 2, 116, 36, 12);
  ctx.fill();
  ctx.stroke();

  // Draw emoji
  ctx.font = "16px Arial";
  ctx.fillStyle = "#000000";
  ctx.fillText("🏠", 8, 24);

  // Draw text
  ctx.font = "12px Arial";
  ctx.fillStyle = "#374151";
  const displayText = address ? trimText(address, 12) : "Nueva nota";
  ctx.fillText(displayText, 28, 24);

  const marker = new mapboxgl.Marker({ element: canvas, anchor: "bottom" })
    .setLngLat([position.lng, position.lat])
    .addTo(map);

  marker.address = address;
  marker.description = description;
  marker.id = id;
  // Guardar lat/lng como números para calcular distancias
  marker.lat = position.lat;
  marker.lng = position.lng;
  marker.position = { lat: position.lat, lng: position.lng };
  marker._visible = true;

  canvas.addEventListener("click", (ev) => {
    ev.stopPropagation();
    currentDetailMarker = marker;
    openDetail(marker);
  });

  return marker;
}

// Helper function to draw rounded rectangles
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function createClusterMarker(position, count) {
  const size = Math.min(40 + count * 2, 60);
  const canvas = document.createElement("canvas");
  canvas.width = size + 4;
  canvas.height = size + 4;
  canvas.style.cssText = "cursor: pointer;";

  const ctx = canvas.getContext("2d");

  // Draw circle background
  ctx.fillStyle = "#ff6b6b";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size / 2 + 2, size / 2 + 2, size / 2, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();

  // Draw text
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.min(14 + count * 0.5, 18)}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = count > 99 ? "99+" : count.toString();
  ctx.fillText(text, size / 2 + 2, size / 2 + 2);

  const marker = new mapboxgl.Marker({ element: canvas, anchor: "center" })
    .setLngLat([position.lng, position.lat])
    .addTo(map);

  marker.count = count;
  marker.lat = position.lat;
  marker.lng = position.lng;
  marker.position = { lat: position.lat, lng: position.lng };
  marker._visible = true;
  marker.isCluster = true;

  canvas.addEventListener("click", (ev) => {
    ev.stopPropagation();
    // Zoom in to expand cluster
    map.easeTo({
      center: [position.lng, position.lat],
      zoom: Math.min(map.getZoom() + 2, 18),
      duration: 500,
    });
  });

  return marker;
}

async function loadHouses() {
  try {
    const bounds = map.getBounds();
    // Si el zoom es muy bajo, no cargar demasiados puntos
    const zoom = map.getZoom();
    const limit = zoom < 8 ? 150 : zoom < 12 ? 400 : 1000;
    const params = new URLSearchParams({
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
      limit: String(limit),
    });

    const response = await fetch(`/api/houses?${params}`);
    const houses = await response.json();

    // Index existentes por id para reusar
    const byId = new Map(markers.map((m) => [m.id, m]));
    const seen = new Set();

    houses.forEach((house) => {
      seen.add(house.id);
      if (byId.has(house.id)) {
        // Actualizar datos básicos disponibles
        const m = byId.get(house.id);
        m.address = house.address;
        m.lat = house.lat;
        m.lng = house.lng;
        m.position = { lat: house.lat, lng: house.lng };
        // No actualizar description ya que no viene en datos básicos
        return;
      }
      const position = { lat: house.lat, lng: house.lng };
      const marker = createMarker(
        position,
        house.address,
        null, // description será cargada bajo demanda
        house.id
      );
      markers.push(marker);
    });

    // Remover marcadores que ya no están en la ventana
    const keep = [];
    for (const m of markers) {
      if (m.id && seen.has(m.id)) keep.push(m);
      else {
        try {
          m.remove();
        } catch (_) {}
      }
    }
    markers = keep;

    // Apply clustering if too many markers
    applyClustering();

    updateMarkersVisibility();
  } catch (error) {
    console.error("Error loading houses:", error);
  }
}

function applyClustering() {
  // Clear existing cluster markers
  clusterMarkers.forEach((m) => {
    try {
      m.remove();
    } catch (_) {}
  });
  clusterMarkers = [];

  const zoom = map.getZoom();
  const visibleMarkers = markers.filter((m) => m._visible);

  // Only cluster if zoom is low and we have many markers
  if (zoom > 12 || visibleMarkers.length < 20) {
    return;
  }

  // Simple clustering: group markers within 0.01 degrees (~1km)
  const clusters = new Map();

  visibleMarkers.forEach((marker) => {
    const key = `${Math.round(marker.lat * 100) / 100}_${
      Math.round(marker.lng * 100) / 100
    }`;
    if (!clusters.has(key)) {
      clusters.set(key, []);
    }
    clusters.get(key).push(marker);
  });

  // Create cluster markers for groups with multiple markers
  clusters.forEach((groupMarkers, key) => {
    if (groupMarkers.length > 1) {
      // Hide individual markers in this cluster
      groupMarkers.forEach((m) => {
        try {
          m.remove();
        } catch (_) {}
        m._visible = false;
      });

      // Calculate cluster center
      const centerLat =
        groupMarkers.reduce((sum, m) => sum + m.lat, 0) / groupMarkers.length;
      const centerLng =
        groupMarkers.reduce((sum, m) => sum + m.lng, 0) / groupMarkers.length;

      // Create cluster marker
      const clusterMarker = createClusterMarker(
        { lat: centerLat, lng: centerLng },
        groupMarkers.length
      );
      clusterMarkers.push(clusterMarker);
    }
  });
}

async function loadEmojis() {
  try {
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    if (zoom < 6) {
      // Evita cargar emojis con zoom muy bajo
      emojiMarkers.forEach((m) => {
        try {
          m.remove();
        } catch (_) {}
      });
      emojiMarkers = [];
      return;
    }
    const limit = zoom < 10 ? 200 : 1000;
    const params = new URLSearchParams({
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
      limit: String(limit),
    });

    const response = await fetch(`/api/houses/emojis?${params}`);
    const emojis = await response.json();

    // Reusar por id
    const byId = new Map(emojiMarkers.map((m) => [m.id, m]));
    const seen = new Set();

    emojis.forEach((e) => {
      const id = e.id;
      seen.add(id);
      const lat = parseFloat(e.lat);
      const lng = parseFloat(e.lng);
      if (byId.has(id)) {
        const m = byId.get(id);
        m.lat = lat;
        m.lng = lng;
        m.emoji = e.emoji;
        m.emojiType = e.emoji_type;
        return;
      }
      const marker = createEmojiMarker({ lat, lng }, e.emoji, e.emoji_type, id);
      emojiMarkers.push(marker);
    });

    // Limpia los que ya no están
    const keep = [];
    for (const m of emojiMarkers) {
      if (m.id && seen.has(m.id)) keep.push(m);
      else {
        try {
          m.remove();
        } catch (_) {}
      }
    }
    emojiMarkers = keep;

    updateEmojiVisibility();
  } catch (error) {
    console.error("Error loading emojis:", error);
  }
}

function createEmojiMarker(position, emoji, emojiType, id) {
  const emojiDiv = document.createElement("div");
  emojiDiv.className = "emoji-marker";
  emojiDiv.textContent = emoji;
  emojiDiv.style.cssText = `
    font-size: 24px;
    cursor: pointer;
    text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
    user-select: none;
  `;

  const marker = new mapboxgl.Marker({
    element: emojiDiv,
    anchor: "center",
  })
    .setLngLat([position.lng, position.lat])
    .addTo(map);

  marker.emoji = emoji;
  marker.emojiType = emojiType;
  marker.id = id;
  marker.lat = position.lat;
  marker.lng = position.lng;
  marker._visible = true;

  // No mostrar información al hacer click en emoji
  // emojiDiv.addEventListener("click", (ev) => {
  //   ev.stopPropagation();
  //   showEmojiInfo(marker);
  // });

  return marker;
}

// Función showEmojiInfo removida - los emojis ya no muestran información al hacer click

async function openDetail(marker, shouldCenter = true) {
  // Centrar mapa sobre la nota para que el popup quede bien posicionado (opcional)
  if (shouldCenter) {
    try {
      map && map.easeTo({ center: [marker.lng, marker.lat], duration: 350 });
    } catch (_) {}
  }

  console.log(
    "Opening detail for marker:",
    marker.id,
    "description:",
    marker.description
  );

  // Mostrar loading mientras se cargan los detalles
  const content = document.createElement("div");
  content.className = "infowindow";
  content.innerHTML = `
    <div class="title">${escapeHtml(marker.address || "Sin dirección")}</div>
    <div class="desc" style="color:#6b7280;">Cargando detalles...</div>
  `;

  // Mostrar popup arriba y ajustar el centro con un offset para dejar espacio
  popup.setDOMContent(content).setLngLat([marker.lng, marker.lat]).addTo(map);
  try {
    const currentZoom = map.getZoom();
    const targetZoom = Math.max(currentZoom, 15);
    const pixelOffsetY = -100; // mueve el centro hacia arriba para que el popup se centre mejor en pantalla
    const from = map.project([marker.lng, marker.lat]);
    const to = { x: from.x, y: from.y + pixelOffsetY };
    const toLngLat = map.unproject(to);
    map.easeTo({
      center: [toLngLat.lng, toLngLat.lat],
      zoom: targetZoom,
      duration: 350,
    });
  } catch (_) {}

  // Si no hay ID, no se pueden cargar/enviar comentarios ni reacciones
  if (!marker.id) return;

  try {
    console.log("Fetching details for marker ID:", marker.id);
    // Fetch detailed data with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for cloud database

    const response = await fetch(`/api/houses/${marker.id}/details`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    console.log("Response status:", response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Response error:", errorText);
      throw new Error(
        `Failed to load house details: ${response.status} ${errorText}`
      );
    }

    const houseDetails = await response.json();
    console.log("House details received:", houseDetails);

    // Update marker with full data
    marker.description = houseDetails.description;
    marker.address = houseDetails.address;

    // Render full content
    content.innerHTML = `
      <div class="title">${escapeHtml(marker.address || "Sin dirección")}</div>
      <div class="desc">${escapeHtml(
        marker.description || "Sin descripción"
      )}</div>

      <div class="house-reactions-section" style="padding: 0 10px; border: 1px solid #ffffff; border-radius: 8px; background: #ffffffff;">
        <div class="house-reactions" style="display:flex; gap:6px; flex-wrap:wrap;"></div>
      </div>

      <div class="comments-section">
        <div class="comments-title"><strong>Comentarios</strong></div>
        <div class="comments-list"></div>
      </div>
      <div class="comment-form quick-form" style="padding: 0 10px;">
        <input id="comment-input" type="text" placeholder="Escribe un comentario..." maxlength="500" autocomplete="off" />
        <div class="actions">
          <button class="primary" id="comment-submit">
            <i class="fa-solid"></i>
          </button>
        </div>
      </div>
    `;

    // Load house reactions
    loadHouseReactions(marker.id, content);

    const listEl = content.querySelector(".comments-list");
    const inputEl = content.querySelector("#comment-input");
    const submitEl = content.querySelector("#comment-submit");

    // Prevent auto-focus on mobile to avoid keyboard appearing automatically
    inputEl.blur();
    inputEl.setAttribute("inputmode", "none");
    setTimeout(() => inputEl.removeAttribute("inputmode"), 100);

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
        const when = c.created_at
          ? new Date(c.created_at).toLocaleString()
          : "";

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
  } catch (error) {
    console.error("Error loading house details:", error);
    let errorMessage = "Error al cargar los detalles";
    if (error.name === "AbortError") {
      errorMessage = "Tiempo de espera agotado al cargar los detalles";
    }
    content.innerHTML = `
      <div class="title">${escapeHtml(marker.address || "Sin dirección")}</div>
      <div class="desc" style="color:#ef4444;">${errorMessage}</div>
    `;
  }
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
      <input id="addr" type="text" placeholder="Título (opcional)" maxlength="70" autocomplete="off" />
      <textarea id="desc" placeholder="Descripción (opcional)" autocomplete="off"></textarea>
      <div class="actions">
        <button class="primary" id="save">Guardar nota</button>
      </div>
    </div>
    <div class="emoji-section" style="border-top: 1px solid #e5e7eb; margin-top: 10px; padding-top: 10px;">
      <div class="emoji-grid">
        <button class="emoji-btn" data-type="NOV"><span class="emoji-icon">❤️</span><span class="emoji-label">NOV</span></button>
        <button class="emoji-btn" data-type="AMA"><span class="emoji-icon">💋</span><span class="emoji-label">AMA</span></button>
        <button class="emoji-btn" data-type="GAY"><span class="emoji-icon">🏳️‍🌈</span><span class="emoji-label">GAY</span></button>
        <button class="emoji-btn" data-type="EX"><span class="emoji-icon">💔</span><span class="emoji-label">EX</span></button>
        <button class="emoji-btn" data-type="COM"><span class="emoji-icon">💍</span><span class="emoji-label">COM</span></button>
        <button class="emoji-btn" data-type="ROL"><span class="emoji-icon">🔥</span><span class="emoji-label">ROL</span></button>
        <button class="emoji-btn" data-type="FAL"><span class="emoji-icon">🎭</span><span class="emoji-label">FAL</span></button>
      </div>
      <div class="emoji-status" style="padding: 8px 0; font-size: 12px; color: #666;"></div>
    </div>
  `;

  popup
    .setDOMContent(content)
    .setLngLat([position.lng, position.lat])
    .addTo(map);

  // Auto-expand del textarea para evitar scroll
  const descEl = content.querySelector("#desc");
  const autoResize = (el) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };
  descEl.addEventListener("input", () => autoResize(descEl));
  setTimeout(() => autoResize(descEl), 0);

  // Prevenir foco automático en móviles
  const addrEl = content.querySelector("#addr");
  if (addrEl) addrEl.blur();
  if (descEl) descEl.blur();

  // Cargar estado de emojis
  updateEmojiStatus(content);

  // Event listeners para botones de emoji
  content.querySelectorAll(".emoji-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const emojiType = btn.getAttribute("data-type");
      try {
        btn.disabled = true;
        const resp = await fetch("/api/houses/emojis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: position.lat,
            lng: position.lng,
            emoji_type: emojiType,
          }),
        });

        if (!resp.ok) {
          const error = await resp.text();
          throw new Error(error);
        }

        const newEmoji = await resp.json();

        // Crear marcador para el nuevo emoji
        const marker = createEmojiMarker(
          position,
          newEmoji.emoji,
          newEmoji.emoji_type,
          newEmoji.id
        );
        emojiMarkers.push(marker);

        // Actualizar estado
        updateEmojiStatus(content);

        // Feedback visual
        btn.style.background = "#e0f2fe";
        setTimeout(() => {
          btn.style.background = "";
        }, 500);

        // Cerrar el modal inmediatamente después de colocar emoji
        setTimeout(() => {
          try {
            popup.remove();
          } catch (_) {}
        }, 300);
      } catch (error) {
        console.error("Error placing emoji:", error);
        alert(error.message || "Error al colocar emoji");
      } finally {
        btn.disabled = false;
      }
    });
  });

  content.querySelector("#save").addEventListener("click", async () => {
    const address = content.querySelector("#addr").value.trim();
    const description = content.querySelector("#desc").value.trim();
    if (!address || !description) return;

    try {
      const houseData = {
        address,
        description,
        lat: position.lat,
        lng: position.lng,
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
      // NO centrar automáticamente al crear nueva nota, solo actualizar visibilidad
      updateMarkersVisibility();
      // Abrir detalle sin centrar el mapa
      openDetail(marker, false);
    } catch (e) {
      console.error("Error saving house:", e);
    }
  });
}

// Función openEmojiForm removida - los emojis se colocan desde el formulario de nueva nota

async function updateEmojiStatus(content) {
  try {
    const resp = await fetch("/api/houses/emojis/daily-count");
    const data = await resp.json();

    const statusEl = content.querySelector(".emoji-status");
    if (statusEl) {
      statusEl.textContent = `Has colocado ${data.count} de ${data.limit} emojis hoy (${data.remaining} restantes)`;
      statusEl.style.color = data.remaining === 0 ? "#ef4444" : "#6b7280";

      // Deshabilitar botones si se alcanzó el límite
      if (data.remaining === 0) {
        content.querySelectorAll(".emoji-btn").forEach((btn) => {
          btn.disabled = true;
          btn.style.opacity = "0.5";
        });
      }
    }
  } catch (error) {
    console.error("Error loading emoji status:", error);
    // Si hay error, mostrar mensaje alternativo
    const statusEl = content.querySelector(".emoji-status");
    if (statusEl) {
      statusEl.textContent = "Función de emojis no disponible temporalmente";
      statusEl.style.color = "#ef4444";
      content.querySelectorAll(".emoji-btn").forEach((btn) => {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      });
    }
  }
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
      )}" autocomplete="off" />
      <textarea id="desc" autocomplete="off">${escapeHtml(
        marker.description || ""
      )}</textarea>
      <div class="actions">
        <button class="primary" id="update">Actualizar</button>
      </div>
    </div>
  `;

  popup.setDOMContent(content).setLngLat([marker.lng, marker.lat]).addTo(map);

  // Prevenir foco automático en móviles
  const addrEl = content.querySelector("#addr");
  const descEl = content.querySelector("#desc");
  if (addrEl) {
    addrEl.blur();
    addrEl.setAttribute("inputmode", "none");
    setTimeout(() => addrEl.removeAttribute("inputmode"), 100);
  }
  if (descEl) {
    descEl.blur();
    descEl.setAttribute("inputmode", "none");
    setTimeout(() => descEl.removeAttribute("inputmode"), 100);
  }

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
      try {
        markers[idx].remove();
      } catch (_) {}
      markers.splice(idx, 1);
    }
    try {
      popup.remove();
    } catch (_) {}
  } catch (e) {
    console.error("Error deleting house:", e);
  }
}

// Configuración de proximidad (en metros)
const PROXIMITY_RADIUS_METERS = 10000; // 10 km para mantener notas visibles más tiempo

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
  const cLat = center.lat;
  const cLng = center.lng;

  let shouldCloseInfo = false;

  markers.forEach((m) => {
    const dist = haversineMeters(cLat, cLng, m.lat, m.lng);
    const visible = dist <= PROXIMITY_RADIUS_METERS;

    if (visible && !m._visible) {
      m.addTo(map);
      m._visible = true;
    } else if (!visible && m._visible) {
      m.remove();
      m._visible = false;
      if (currentDetailMarker && m === currentDetailMarker)
        shouldCloseInfo = true;
    }
  });

  // Update cluster visibility
  clusterMarkers.forEach((m) => {
    const dist = haversineMeters(cLat, cLng, m.lat, m.lng);
    const visible = dist <= PROXIMITY_RADIUS_METERS;

    if (visible && !m._visible) {
      m.addTo(map);
      m._visible = true;
    } else if (!visible && m._visible) {
      m.remove();
      m._visible = false;
    }
  });

  if (shouldCloseInfo) {
    try {
      popup.remove();
    } catch (_) {}
    currentDetailMarker = null;
  }
}

// Actualiza visibilidad de emojis según distancia al centro del mapa
function updateEmojiVisibility() {
  if (!map) return;
  const center = map.getCenter();
  const cLat = center.lat;
  const cLng = center.lng;

  emojiMarkers.forEach((m) => {
    const dist = haversineMeters(cLat, cLng, m.lat, m.lng);
    const visible = dist <= PROXIMITY_RADIUS_METERS;

    if (visible && !m._visible) {
      m.addTo(map);
      m._visible = true;
    } else if (!visible && m._visible) {
      m.remove();
      m._visible = false;
    }
  });
}

// -------- Top 10 Lógica --------
let cachedTop = [];
let topLoadedOnce = false;

async function fetchTopNotes() {
  const resp = await fetch("/api/houses/top?limit=10");
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
  list.slice(0, 10).forEach((item, idx) => {
    const el = document.createElement("div");
    el.className = "top-item";
    el.innerHTML = `
      <div class="top-rank">${idx + 1}</div>
      <div class="top-content">
        <div class="top-title">${escapeHtml(
          item.address || "Sin dirección"
        )}</div>
        <div class="top-desc">${escapeHtml(
          item.description || "Sin descripción"
        )}</div>
        <div class="top-meta">💬 ${item.comment_count || 0} comentarios</div>
      </div>
    `;
    el.addEventListener("click", () => {
      const marker = markers.find((m) => m.id === item.id);
      if (marker) {
        const pos = { lat: marker.lat, lng: marker.lng };
        map.setCenter([pos.lng, pos.lat]);
        map.setZoom(17);
        openDetail(marker);
      } else {
        const position = { lat: item.lat, lng: item.lng };
        const tempMarker = createMarker(
          position,
          item.address,
          item.description,
          item.id
        );
        markers.push(tempMarker);
        map.setCenter([position.lng, position.lat]);
        map.setZoom(17);
        openDetail(tempMarker);
      }
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
        console.error("Error cargando Top 10:", e);
        const container = document.getElementById("top-list");
        if (container)
          container.innerHTML =
            '<div style="padding:12px;color:#ef4444;font-size:13px;">No se pudo cargar el Top 10</div>';
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

// Export functionality
function setupExportButtons() {
  const exportJsonBtn = document.getElementById("export-json");
  const exportCsvBtn = document.getElementById("export-csv");

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener("click", () => {
      exportData("json");
    });
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", () => {
      exportData("csv");
    });
  }
}

async function exportData(format) {
  try {
    const response = await fetch(
      `/api/houses/export?format=${format}&limit=10000`
    );
    if (!response.ok) throw new Error("Export failed");

    // Create download link
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;

    // Get filename from response headers
    const contentDisposition = response.headers.get("Content-Disposition");
    let filename = `rumormx_export.${format}`;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="(.+)"/);
      if (filenameMatch) {
        filename = filenameMatch[1];
      }
    }

    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    // Show success message
    alert(`Datos exportados exitosamente como ${format.toUpperCase()}`);
  } catch (error) {
    console.error("Export error:", error);
    alert("Error al exportar los datos. Inténtalo de nuevo.");
  }
}

// Initialize export buttons when DOM is ready
document.addEventListener("DOMContentLoaded", setupExportButtons);
