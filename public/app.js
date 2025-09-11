let map;
let markers = [];
let emojiMarkers = [];
let clusterMarkers = [];
let chatZoneMarkers = [];
let popup;
let currentDetailMarker = null;
let loadHousesButton = null;
let chatZoneButton = null;
let isLoadingHouses = false;
let lastLoadedBounds = null;

// Limites aproximados de México (para restringir el viewport)
const MEXICO_BOUNDS = {
  north: 32.7,
  south: 14.5,
  west: -118.4,
  east: -86.7,
};

window.addEventListener("load", async () => {
  // Load chat zones immediately on page load
  await loadChatZones();

  await initMap();
  setupTopPanel();
  setupDonationModal();
  loadDonationProgress(); // Load donation progress on page load

  // Restore chat session if user was previously in a chat
  restoreChatSession();
});

// Debounce helper
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Retry helper with exponential backoff
async function retryFetch(
  url,
  options = {},
  maxRetries = 3,
  baseDelay = 1000,
  onProgress = null
) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (onProgress) {
        onProgress(attempt + 1, maxRetries + 1, "connecting");
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 second timeout

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (onProgress) {
        onProgress(attempt + 1, maxRetries + 1, "success");
      }

      return response;
    } catch (error) {
      lastError = error;

      if (error.name === "AbortError") {
        console.warn(
          `Request timeout on attempt ${attempt + 1}/${
            maxRetries + 1
          } for ${url}`
        );
        if (onProgress) {
          onProgress(attempt + 1, maxRetries + 1, "timeout");
        }
      } else {
        console.warn(
          `Request failed on attempt ${attempt + 1}/${
            maxRetries + 1
          } for ${url}:`,
          error.message
        );
        if (onProgress) {
          onProgress(attempt + 1, maxRetries + 1, "error");
        }
      }

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000; // Exponential backoff with jitter
        console.log(`Retrying in ${Math.round(delay)}ms...`);
        if (onProgress) {
          onProgress(
            attempt + 1,
            maxRetries + 1,
            "retrying",
            Math.round(delay)
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (onProgress) {
    onProgress(maxRetries + 1, maxRetries + 1, "failed");
  }

  throw lastError;
}

async function initMap() {
  const center = { lat: 23.6345, lng: -102.5528 };

  // MapLibre no requiere token, es gratuito

  // Inicializar botones
  loadHousesButton = document.getElementById("load-houses-button");
  chatZoneButton = document.getElementById("chat-zone-button");

  // Crear mapa full-screen con límites de México
  map = new maplibregl.Map({
    container: "map",
    style: "https://api.maptiler.com/maps/streets/style.json?key=H27Cy6WhpwA1W2G3Uqz1", // MapTiler con ciudades detalladas
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

  popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    offset: 28, // separación vertical del marcador
    anchor: "bottom", // siempre mostrar arriba de la nota
  });

  map.on("load", async () => {
    // Inicializar botones
    setupLoadHousesButton();
    setupChatZoneButton();
    setupCreatePrivateChatButton();

    // No cargar casas automáticamente, solo emojis
    await loadEmojis();
    // Chat zones are already loaded on page load, just update visibility
    preloadTopNotes();

    updateMarkersVisibility();
    updateEmojiVisibility();
    updateClusterVisibility();
    updateChatZoneMarkersVisibility(); // Update chat zone markers visibility

    // Initial button visibility and nearby chat check
    updateLoadHousesButtonVisibility();
    updateChatZoneButtonVisibility();
    updateCreatePrivateChatButtonVisibility();
    checkNearbyChats();

    // Start periodic chat zones refresh
    startChatZonesRefresh();

    const refresh = debounce(async () => {
      // Solo actualizar visibilidad, no cargar casas automáticamente
      // Add chat zone markers to map now that it's ready
      console.log('Map loaded, adding chat zone markers:', chatZoneMarkers.length);
      console.log('Current map zoom:', map.getZoom());
      console.log('Current map center:', map.getCenter());
  
      chatZoneMarkers.forEach((marker, index) => {
        console.log(`Processing marker ${index}:`, {
          zoneId: marker.zoneId,
          lat: marker.lat,
          lng: marker.lng,
          visible: marker._visible,
          hasElement: !!marker.getElement()
        });
  
        if (!marker._visible) {
          try {
            marker.addTo(map);
            marker._visible = true;
            console.log(`Successfully added marker ${index} to map`);
          } catch (error) {
            console.error(`Failed to add marker ${index} to map:`, error);
          }
        } else {
          console.log(`Marker ${index} already visible`);
        }
      });
  
      // Force visibility update after adding markers
      setTimeout(() => {
        updateChatZoneMarkersVisibility();
      }, 1000);
  
      updateMarkersVisibility();
      updateEmojiVisibility();
      updateClusterVisibility();
      updateChatZoneMarkersVisibility(); // Update chat zone markers visibility
      updateLoadHousesButtonVisibility();
      updateChatZoneButtonVisibility();
      updateCreatePrivateChatButtonVisibility();

      // Check if user moved away from chat zone
      checkChatZoneProximity();

      // Check for nearby active chats
      checkNearbyChats();
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

  const marker = new maplibregl.Marker({ element: canvas, anchor: "bottom" })
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

  const marker = new maplibregl.Marker({ element: canvas, anchor: "center" })
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

  const marker = new maplibregl.Marker({
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
    console.log("Fetching full data for marker ID:", marker.id);
    // Fetch all data in a single request
    const response = await retryFetch(`/api/houses/${marker.id}/full`);

    console.log("Response status:", response.status);
    const fullData = await response.json();
    console.log("Full data received:", fullData);

    if (!fullData) {
      throw new Error("Vivienda no encontrada");
    }

    // Update marker with full data
    marker.description = fullData.house.description;
    marker.address = fullData.house.address;

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
        <div class="comments-title"><strong>Comentarios</strong> (${fullData.comments.length})</div>
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

    // Load house reactions from the full data
    renderHouseReactions(fullData.house_reactions, content, marker.id);

    const listEl = content.querySelector(".comments-list");
    const inputEl = content.querySelector("#comment-input");
    const submitEl = content.querySelector("#comment-submit");

    // Prevent auto-focus on mobile to avoid keyboard appearing automatically
    inputEl.blur();
    inputEl.setAttribute("inputmode", "none");
    setTimeout(() => inputEl.removeAttribute("inputmode"), 100);

    let currentOffset = 0;
    const commentsPerPage = 20;
    let allComments = [];
    let hasMoreComments = false;

    const renderComments = (comments, pagination) => {
      if (!Array.isArray(comments) || comments.length === 0) {
        listEl.innerHTML =
          '<div class="comment-empty" style="color:#6b7280;font-size:13px;">Sé el primero en comentar</div>';
        return;
      }

      // If this is the first load, clear the list
      if (currentOffset === 0) {
        listEl.innerHTML = "";
        allComments = [];
      }

      // Add new comments to the collection
      allComments = allComments.concat(comments);

      // Update pagination info
      if (pagination) {
        hasMoreComments = pagination.hasMore;
        currentOffset = pagination.offset + pagination.limit;
      }

      // Re-render all comments
      listEl.innerHTML = "";
      allComments.forEach((c) => {
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

      // Add "Load More" button if there are more comments
      if (hasMoreComments) {
        const loadMoreBtn = document.createElement("button");
        loadMoreBtn.className = "load-more-comments";
        loadMoreBtn.style.cssText = "width:100%; padding:8px; margin:8px 0; background:#f3f4f6; border:1px solid #d1d5db; border-radius:6px; color:#374151; font-size:13px; cursor:pointer;";
        loadMoreBtn.textContent = "Cargar más comentarios";
        loadMoreBtn.addEventListener("click", loadMoreComments);
        listEl.appendChild(loadMoreBtn);
      }
    };

    const loadMoreComments = async () => {
      try {
        const loadMoreBtn = listEl.querySelector(".load-more-comments");
        if (loadMoreBtn) {
          loadMoreBtn.disabled = true;
          loadMoreBtn.textContent = "Cargando...";
        }

        const params = new URLSearchParams({
          limit: String(commentsPerPage),
          offset: String(currentOffset)
        });

        const resp = await retryFetch(`/api/houses/${marker.id}/comments?${params}`);
        const data = await resp.json();

        renderComments(data.comments, data.pagination);
      } catch (e) {
        console.error("Error cargando más comentarios:", e);
        const loadMoreBtn = listEl.querySelector(".load-more-comments");
        if (loadMoreBtn) {
          loadMoreBtn.disabled = false;
          loadMoreBtn.textContent = "Cargar más comentarios";
        }
      }
    };

    // Render comments from the full data
    const mockPagination = {
      total: fullData.comments.length,
      limit: 20,
      offset: 0,
      hasMore: false // For now, assume no more in full endpoint
    };
    renderComments(fullData.comments, mockPagination);

    const loadComments = debounce(async () => {
      try {
        listEl.innerHTML =
          '<div style="color:#6b7280;font-size:13px;">Cargando comentarios...</div>';
        const params = new URLSearchParams({
          limit: String(commentsPerPage),
          offset: "0"
        });
        const resp = await retryFetch(`/api/houses/${marker.id}/comments?${params}`);
        const data = await resp.json();
        renderComments(data.comments, data.pagination);
      } catch (e) {
        console.error("Error cargando comentarios:", e);
        listEl.innerHTML =
          '<div style="color:#ef4444;font-size:13px;">No se pudieron cargar los comentarios. Reintentando...</div>';
        // Auto-retry once after a delay
        setTimeout(() => loadComments(), 2000);
      }
    }, 300);

    let isSubmittingComment = false;
    submitEl.addEventListener("click", async () => {
      const txt = (inputEl.value || "").trim();
      if (!txt || isSubmittingComment) return;

      isSubmittingComment = true;
      const originalText = submitEl.textContent;
      submitEl.disabled = true;
      submitEl.textContent = "Enviando...";

      try {
        const resp = await retryFetch(`/api/houses/${marker.id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comment: txt }),
        });

        if (resp.ok) {
          inputEl.value = "";
          // Reload comments to show the new one
          await loadComments();
        } else {
          throw new Error("Error en la respuesta del servidor");
        }
      } catch (e) {
        console.error("Error enviando comentario:", e);
        alert("No se pudo enviar el comentario. Reinténtalo.");
      } finally {
        isSubmittingComment = false;
        submitEl.disabled = false;
        submitEl.textContent = originalText;
      }
    });
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
    const resp = await retryFetch(`/api/houses/${houseId}/reactions`);
    const data = await resp.json();

    renderHouseReactions(data, content, houseId);
  } catch (e) {
    console.error("Error cargando reacciones de casa:", e);
    // Show error state in reactions section
    const reactionsContainer = content.querySelector(".house-reactions");
    if (reactionsContainer) {
      reactionsContainer.innerHTML =
        '<div style="color:#ef4444;font-size:12px;">Error cargando reacciones</div>';
    }
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
          resp = await retryFetch(`/api/houses/${houseId}/reactions`, {
            method: "DELETE",
          });
        } else {
          // set/update -> POST
          resp = await retryFetch(`/api/houses/${houseId}/reactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reaction }),
          });
        }
        const newData = await resp.json();

        // Update local state and re-render
        data.reactions = newData.reactions || data.reactions || {};
        data.user_reaction =
          newData.user_reaction ?? data.user_reaction ?? null;
        renderHouseReactions(data, content, houseId);
      } catch (e) {
        console.error("Error al reaccionar:", e);
        alert("No se pudo registrar la reacción. Reinténtalo.");
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
        <button class="emoji-btn" data-type="COM"><span class="emoji-icon">🚩</span><span class="emoji-label">RED</span></button>
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
        const resp = await retryFetch("/api/houses/emojis", {
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

    // Evitar envíos múltiples
    if (content.__isSaving) return;
    content.__isSaving = true;

    const saveBtn = content.querySelector("#save");
    const prevText = saveBtn ? saveBtn.textContent : null;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add("loading");
      saveBtn.setAttribute("aria-busy", "true");
      saveBtn.textContent = "Guardando...";
    }

    try {
      const houseData = {
        address,
        description,
        lat: position.lat,
        lng: position.lng,
      };

      const resp = await retryFetch("/api/houses", {
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
      alert(
        "No se pudo guardar la nota. Has alcanzado el límite de 10 notas por día."
      );
    } finally {
      content.__isSaving = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.classList.remove("loading");
        saveBtn.removeAttribute("aria-busy");
        if (prevText != null) saveBtn.textContent = prevText;
      }
    }
  });
}

// Función openEmojiForm removida - los emojis se colocan desde el formulario de nueva nota

async function updateEmojiStatus(content) {
  try {
    const resp = await retryFetch("/api/houses/emojis/daily-count");
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
      const resp = await retryFetch(`/api/houses/${marker.id}`, {
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
    const resp = await retryFetch(`/api/houses/${id}`, { method: "DELETE" });
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

// Actualiza visibilidad de clusters según distancia al centro del mapa
function updateClusterVisibility() {
  if (!map) return;
  const center = map.getCenter();
  const cLat = center.lat;
  const cLng = center.lng;

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
}

// -------- Top 10 Lógica --------
let cachedTop = [];
let topLoadedOnce = false;

async function fetchTopNotes() {
  const resp = await retryFetch("/api/houses/top?limit=10");
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
        // Load donation progress when panel opens
        loadDonationProgress();
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
    const response = await retryFetch(
      `/api/houses/export?format=${format}&limit=10000`
    );

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

// Setup load houses button functionality
function setupLoadHousesButton() {
  if (!loadHousesButton) return;

  loadHousesButton.addEventListener("click", async () => {
    if (isLoadingHouses) return;

    await loadHousesManually();
  });

  // Initial check for button visibility
  updateLoadHousesButtonVisibility();
}

// Setup chat zone button functionality
function setupChatZoneButton() {
  console.log('Setting up chat zone button:', chatZoneButton);
  if (!chatZoneButton) {
    console.error('Chat zone button not found!');
    return;
  }

  chatZoneButton.addEventListener("click", async () => {
    console.log('Chat zone button clicked');
    createPrivateChat();
  });

  console.log('Chat zone button event listener attached');

  // Initial check for button visibility
  updateChatZoneButtonVisibility();
}

// Setup create private chat button functionality
function setupCreatePrivateChatButton() {
  const createPrivateChatButton = document.getElementById("create-private-chat-button");
  console.log('Setting up create private chat button:', createPrivateChatButton);

  if (!createPrivateChatButton) {
    console.error('Create private chat button not found!');
    return;
  }

  createPrivateChatButton.addEventListener("click", async () => {
    console.log('Create private chat button clicked');
    createPrivateChat();
  });

  console.log('Create private chat button event listener attached');

  // Initial check for button visibility
  updateCreatePrivateChatButtonVisibility();
}

// Update create private chat button visibility
function updateCreatePrivateChatButtonVisibility() {
  const createPrivateChatButton = document.getElementById("create-private-chat-button");
  if (!createPrivateChatButton) return;

  const zoom = map.getZoom();

  // Show button when zoomed in enough (>= 14, same as other buttons)
  if (zoom >= 14) {
    createPrivateChatButton.style.display = "flex";
    createPrivateChatButton.classList.add("show");
  } else {
    createPrivateChatButton.classList.remove("show");
    setTimeout(() => {
      createPrivateChatButton.style.display = "none";
    }, 300); // Wait for animation to complete
  }
}


// Check if there are houses nearby and show/hide the button
async function checkHousesNearby() {
  try {
    const bounds = map.getBounds();
    const zoom = map.getZoom();

    // Use existing endpoint with limit 1 to check if there are houses
    const params = new URLSearchParams({
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
      limit: "1", // Just check if there's at least one house
    });

    const response = await retryFetch(`/api/houses?${params}`, {}, 1, 1000);
    const houses = await response.json();

    // Check if there are any houses in the area
    return houses.length > 0;
  } catch (error) {
    console.error("Error checking houses nearby:", error);
    return false;
  }
}

// Update load houses button visibility based on proximity and zoom
async function updateLoadHousesButtonVisibility() {
  if (!loadHousesButton) return;

  const zoom = map.getZoom();

  // Show button only when user is very close to the map (>= 14), for highly focused area loading
  if (zoom >= 14) {
    loadHousesButton.style.display = "flex";
    loadHousesButton.classList.add("show");
  } else {
    loadHousesButton.classList.remove("show");
    setTimeout(() => {
      loadHousesButton.style.display = "none";
    }, 300); // Wait for animation to complete
  }
}

// Update chat zone button visibility based on zoom
function updateChatZoneButtonVisibility() {
  if (!chatZoneButton) {
    console.error('Chat zone button not found');
    return;
  }

  const zoom = map.getZoom();

  // Show button when zoomed in enough for area chat (>= 14, same as eye button)
  console.log('Chat button visibility check - zoom:', zoom, 'button element:', chatZoneButton);
  if (zoom >= 14) {
    chatZoneButton.style.display = "flex";
    chatZoneButton.classList.add("show");
    console.log('Chat button should be visible');
  } else {
    chatZoneButton.classList.remove("show");
    setTimeout(() => {
      chatZoneButton.style.display = "none";
    }, 300); // Wait for animation to complete
    console.log('Chat button should be hidden');
  }
}


// Clear all markers and clusters from the map
function clearAllMarkers() {
  // Clear house markers
  markers.forEach((m) => {
    try {
      m.remove();
    } catch (_) {}
  });
  markers = [];

  // Clear cluster markers
  clusterMarkers.forEach((m) => {
    try {
      m.remove();
    } catch (_) {}
  });
  clusterMarkers = [];

  // Clear chat zone markers
  chatZoneMarkers.forEach((m) => {
    try {
      m.remove();
    } catch (_) {}
  });
  chatZoneMarkers = [];
}

// Load houses manually when button is clicked
async function loadHousesManually() {
  if (isLoadingHouses) return;

  const zoom = map.getZoom();
  if (zoom < 14) {
    alert("Acércate más al mapa para cargar las notas (zoom mínimo: 14)");
    return;
  }

  try {
    isLoadingHouses = true;
    loadHousesButton.classList.add("loading");

    const bounds = map.getBounds();

    // Calculate limit based on zoom level (same as original loadHouses function)
    const limit = zoom < 8 ? 150 : zoom < 12 ? 400 : 1000;

    // Use existing houses endpoint
    const params = new URLSearchParams({
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
      limit: String(limit),
    });

    // Load houses and emojis simultaneously
    const [housesResponse, emojisResponse] = await Promise.all([
      retryFetch(`/api/houses?${params}`),
      retryFetch(`/api/houses/emojis?${params}`),
    ]);

    const houses = await housesResponse.json();
    const emojis = await emojisResponse.json();

    // Index existing markers by id to avoid duplicates
    const existingMarkers = new Map(markers.map((m) => [m.id, m]));
    const existingEmojis = new Map(emojiMarkers.map((m) => [m.id, m]));
    let newMarkersAdded = 0;
    let newEmojisAdded = 0;

    // Process houses and create markers (only add new ones)
    houses.forEach((house) => {
      if (!existingMarkers.has(house.id)) {
        const position = { lat: house.lat, lng: house.lng };
        const marker = createMarker(
          position,
          house.address,
          null, // description será cargada bajo demanda
          house.id
        );
        markers.push(marker);
        newMarkersAdded++;
      }
    });

    // Process emojis and create markers (only add new ones)
    emojis.forEach((emoji) => {
      if (!existingEmojis.has(emoji.id)) {
        const position = {
          lat: parseFloat(emoji.lat),
          lng: parseFloat(emoji.lng),
        };
        const emojiMarker = createEmojiMarker(
          position,
          emoji.emoji,
          emoji.emoji_type,
          emoji.id
        );
        emojiMarkers.push(emojiMarker);
        newEmojisAdded++;
      }
    });

    // Only apply clustering if new markers were added
    if (newMarkersAdded > 0) {
      applyClustering();
      updateMarkersVisibility();
      updateClusterVisibility();
    }

    // Update emoji visibility if new emojis were added
    if (newEmojisAdded > 0) {
      updateEmojiVisibility();
    }

    // Keep the button visible for loading more areas
    // Don't hide it after successful loading

    console.log(
      `Se agregaron ${newMarkersAdded} nuevas notas y ${newEmojisAdded} nuevos emojis`
    );

    if (newMarkersAdded === 0 && newEmojisAdded === 0) {
      // Show message if no new content was found
      console.log("No se encontraron nuevas notas ni emojis en esta área");
    }
  } catch (error) {
    console.error("Error loading houses and emojis manually:", error);
    alert("Error al cargar las notas y emojis. Inténtalo de nuevo.");
  } finally {
    isLoadingHouses = false;
    loadHousesButton.classList.remove("loading");
  }
}

// Create chat zone marker
function createChatZoneMarker(zone) {
  console.log('Creating chat zone marker for zone:', zone);

  const chatIcon = document.createElement("div");
  chatIcon.className = "chat-zone-marker";
  chatIcon.innerHTML = `
    <div class="chat-zone-marker-content">
      <i class="fas fa-comments"></i>
      <span class="chat-zone-count">${zone.userCount}</span>
    </div>
  `;

  chatIcon.style.cssText = `
    position: relative;
    width: 40px;
    height: 40px;
    background: #10b981;
    border: 2px solid white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
    transition: all 0.2s ease;
    color: white;
    font-size: 14px;
  `;

  console.log('Creating marker with coordinates:', zone.lng, zone.lat);

  const marker = new maplibregl.Marker({
    element: chatIcon,
    anchor: "center",
  })
    .setLngLat([zone.lng, zone.lat]);

  marker.zoneId = zone.zoneId;
  marker.userCount = zone.userCount;
  marker.lat = zone.lat;
  marker.lng = zone.lng;
  marker._visible = false; // Start as not visible, will be set when added to map

  console.log('Marker created:', marker);

  // Add hover effects
  chatIcon.addEventListener("mouseenter", () => {
    chatIcon.style.transform = "scale(1.1)";
    chatIcon.style.boxShadow = "0 4px 12px rgba(16, 185, 129, 0.4)";
  });

  chatIcon.addEventListener("mouseleave", () => {
    chatIcon.style.transform = "scale(1)";
    chatIcon.style.boxShadow = "0 2px 8px rgba(16, 185, 129, 0.3)";
  });

  // Add click handler to join chat
  chatIcon.addEventListener("click", () => {
    console.log('Chat marker clicked for zone:', zone.zoneId);

    // Check if this is a private chat marker (starts with 'room_')
    if (zone.zoneId.startsWith('room_')) {
      // This is a private chat marker - join it immediately
      console.log('Joining private chat:', zone.zoneId);
      joinPrivateChat(zone.zoneId);
    } else {
      // This is a regular zone chat
      // If user is already in a chat, leave it first
      if (window.currentChat) {
        leaveChatZone();
      }

      // Open chat setup modal
      openChatSetupModal();

      // Optionally center map on the zone
      if (map) {
        map.easeTo({
          center: [zone.lng, zone.lat],
          zoom: Math.max(map.getZoom(), 12),
          duration: 500
        });
      }
    }
  });

  return marker;
}

// Load all active chat zones
async function loadChatZones() {
  try {
    console.log('Loading chat zones...');
    const response = await fetch('/api/chat/zones');
    if (!response.ok) {
      console.error('Failed to fetch chat zones:', response.status);
      return;
    }

    const data = await response.json();
    const zones = data.zones || [];
    console.log('Received chat zones:', zones);

    // Clear existing chat zone markers
    chatZoneMarkers.forEach((m) => {
      try {
        m.remove();
      } catch (_) {}
    });
    chatZoneMarkers = [];

    // Create markers for active zones
    zones.forEach((zone) => {
      console.log('Creating marker for zone:', zone);
      // Check if marker already exists for this zone
      const existingMarker = chatZoneMarkers.find(m => m.zoneId === zone.zoneId);

      if (existingMarker) {
        // Update existing marker user count
        existingMarker.userCount = zone.userCount;
        const countElement = existingMarker.getElement().querySelector('.chat-zone-count');
        if (countElement) {
          countElement.textContent = zone.userCount;
        }
      } else {
        // Create new marker
        const marker = createChatZoneMarker(zone);
        chatZoneMarkers.push(marker);

        // If map is ready, add marker to map immediately
        if (map) {
          console.log('Adding marker to map:', marker);
          marker.addTo(map);
          marker._visible = true;
        } else {
          console.log('Map not ready, marker will be added later');
        }
      }
    });

    // Remove markers for zones that no longer exist
    const activeZoneIds = zones.map(z => z.zoneId);
    const markersToRemove = chatZoneMarkers.filter(m => !activeZoneIds.includes(m.zoneId));

    markersToRemove.forEach(marker => {
      try {
        marker.remove();
      } catch (_) {}
    });

    chatZoneMarkers = chatZoneMarkers.filter(m => activeZoneIds.includes(m.zoneId));

    console.log(`Loaded ${zones.length} active chat zones, ${chatZoneMarkers.length} markers created`);

    // If no zones found, create a test zone for debugging
    if (zones.length === 0) {
      console.log('No active chat zones found, creating test zone for debugging');
      // This is just for debugging - remove in production
      const testZone = {
        zoneId: '23.6_-102.5',
        lat: 23.6,
        lng: -102.5,
        userCount: 1
      };

      const testMarker = createChatZoneMarker(testZone);
      chatZoneMarkers.push(testMarker);

      if (map) {
        testMarker.addTo(map);
        testMarker._visible = true;
        console.log('Added test marker to map');
      }
    }

  } catch (error) {
    console.error('Error loading chat zones:', error);
  }
}

// Update chat zone markers visibility based on zoom and distance
function updateChatZoneMarkersVisibility() {
  if (!map) {
    console.log('Map not ready for visibility update');
    return;
  }

  const center = map.getCenter();
  const cLat = center.lat;
  const cLng = center.lng;
  const zoom = map.getZoom();

  console.log('Updating chat zone visibility - zoom:', zoom, 'center:', cLat, cLng);

  // Only show chat zone markers at certain zoom levels
  const showMarkers = zoom >= 5; // Temporarily lowered for debugging
  console.log('Show markers based on zoom:', showMarkers);

  chatZoneMarkers.forEach((marker, index) => {
    const dist = haversineMeters(cLat, cLng, marker.lat, marker.lng);
    const visible = showMarkers && dist <= PROXIMITY_RADIUS_METERS;

    console.log(`Marker ${index} (${marker.zoneId}): dist=${dist.toFixed(0)}m, visible=${visible}, currently=${marker._visible}`);

    if (visible && !marker._visible) {
      console.log(`Showing marker ${index}`);
      marker.addTo(map);
      marker._visible = true;
    } else if (!visible && marker._visible) {
      console.log(`Hiding marker ${index}`);
      marker.remove();
      marker._visible = false;
    }
  });
}

// Update specific chat zone marker user count
function updateChatZoneMarkerCount(zoneId, userCount) {
  const marker = chatZoneMarkers.find(m => m.zoneId === zoneId);
  if (marker) {
    marker.userCount = userCount;

    // Update the count display
    const countElement = marker.getElement().querySelector('.chat-zone-count');
    if (countElement) {
      countElement.textContent = userCount;
    }

    // Remove marker if no users left
    if (userCount === 0) {
      try {
        marker.remove();
      } catch (_) {}
      chatZoneMarkers = chatZoneMarkers.filter(m => m.zoneId !== zoneId);
    }
  }
}

// Initialize export buttons when DOM is ready
document.addEventListener("DOMContentLoaded", setupExportButtons);

// Setup donation modal functionality
function setupDonationModal() {
  const modal = document.getElementById("donation-modal");
  const closeBtn = document.getElementById("donation-modal-close");

  if (!modal) return;

  // Show modal on page load with a slight delay
  setTimeout(() => {
    modal.classList.add("show");
  }, 1000); // 1 second delay

  // Close modal when clicking the close button
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      modal.classList.remove("show");
    });
  }

  // Close modal when clicking outside the modal content
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.remove("show");
    }
  });

  // Close modal with Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("show")) {
      modal.classList.remove("show");
    }
  });
}

// Create a new private chat room
async function createPrivateChat() {
  try {
    // Check if user is already in a chat
    if (window.currentChat || window.currentPrivateChat) {
      alert('Ya estás en un chat. Sal del chat actual primero.');
      return;
    }

    const center = map.getCenter();
    const position = { lat: center.lat, lng: center.lng };

    // Get user info from localStorage or prompt for it
    let userInfo = localStorage.getItem('privateChatUserInfo');
    if (!userInfo) {
      openPrivateChatSetupModal(null, true); // true = creating new chat
      return;
    }

    userInfo = JSON.parse(userInfo);

    // Create private chat room and join immediately
    const response = await fetch('/api/chat/private/create-and-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: position.lat,
        lng: position.lng,
        username: userInfo.username,
        gender: userInfo.gender
      })
    });

    if (!response.ok) {
      throw new Error('Failed to create private chat');
    }

    const data = await response.json();
    const chatRoom = data.chatRoom;

    // Create marker for the private chat using existing chat zone marker system
    const marker = createChatZoneMarker({
      zoneId: chatRoom.id,
      lat: chatRoom.lat,
      lng: chatRoom.lng,
      userCount: 1
    });

    // Override the click handler for private chat
    const markerElement = marker.getElement();
    markerElement.addEventListener("click", () => {
      console.log('Private chat marker clicked for room:', chatRoom.id);
      joinPrivateChat(chatRoom.id);
    });

    chatZoneMarkers.push(marker);

    // Add marker to map
    marker.addTo(map);
    marker._visible = true;

    // Open chat interface for creator
    startPrivateChat(data.chatSession, userInfo);

    console.log('Created and joined private chat room:', chatRoom.id);

  } catch (error) {
    console.error('Error creating private chat:', error);
    alert('Error al crear chat privado. Inténtalo de nuevo.');
  }
}


// Join private chat room
async function joinPrivateChat(chatRoomId) {
  try {
    // Check if user is already in a chat
    if (window.currentChat || window.currentPrivateChat) {
      alert('Ya estás en un chat. Sal del chat actual primero.');
      return;
    }

    // Get user info from localStorage or prompt for it
    let userInfo = localStorage.getItem('privateChatUserInfo');
    if (!userInfo) {
      // Use same modal as zone chat but for private chat
      openPrivateChatSetupModal(chatRoomId);
      return;
    }

    userInfo = JSON.parse(userInfo);

    // Join the private chat
    const response = await fetch('/api/chat/private/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatRoomId,
        username: userInfo.username,
        gender: userInfo.gender
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to join private chat');
    }

    const data = await response.json();

    // Remove marker immediately when joining
    const markerIndex = chatZoneMarkers.findIndex(m => m.zoneId === chatRoomId);
    if (markerIndex !== -1) {
      const marker = chatZoneMarkers[markerIndex];
      marker.remove();
      chatZoneMarkers.splice(markerIndex, 1);
    }

    // Start private chat
    startPrivateChat(data.chatSession, userInfo);

  } catch (error) {
    console.error('Error joining private chat:', error);
    alert('Error al unirse al chat privado: ' + error.message);
  }
}


// Start private chat between two users
function startPrivateChat(chatSession, userInfo) {
  const isWaiting = chatSession.status === 'waiting';
  const welcomeMessage = isWaiting
    ? '<p>¡Chat privado creado!</p><p>Esperando a que alguien se conecte...</p>'
    : '<p>¡Chat privado iniciado!</p><p>Conectando con el otro usuario...</p>';

  // Create private chat interface
  const chatHTML = `
    <div id="private-chat-panel" class="private-chat-panel">
      <div class="chat-header">
        <div class="chat-zone-info">
          <i class="fas fa-lock"></i>
          <span>Chat Privado</span>
        </div>
        <div class="chat-user-info">
          <span class="chat-username">${userInfo.username}</span>
          <span class="chat-gender">${userInfo.gender === 'M' ? '♂️' : '♀️'}</span>
        </div>
        <button id="private-chat-close" class="chat-close-btn" title="Salir del chat">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="chat-messages" id="private-chat-messages">
        <div class="chat-welcome">
          ${welcomeMessage}
        </div>
      </div>
      <div class="chat-input-area">
        <input
          type="text"
          id="private-chat-input"
          placeholder="Escribe un mensaje..."
          maxlength="200"
          autocomplete="off"
        />
        <button id="private-chat-send" class="chat-send-btn">
          <i class="fas fa-paper-plane"></i>
        </button>
      </div>
    </div>
  `;

  // Add chat panel to body
  document.body.insertAdjacentHTML('beforeend', chatHTML);

  // Get chat elements
  const chatPanel = document.getElementById("private-chat-panel");
  const chatInput = document.getElementById("private-chat-input");
  const chatSend = document.getElementById("private-chat-send");
  const chatClose = document.getElementById("private-chat-close");
  const chatMessages = document.getElementById("private-chat-messages");

  // Show chat panel with animation
  setTimeout(() => {
    chatPanel.classList.add('show');
  }, 100);

  // Focus on input
  setTimeout(() => chatInput.focus(), 300);

  // Event listeners
  chatClose.addEventListener("click", () => {
    leavePrivateChat(chatSession.id);
  });

  chatSend.addEventListener("click", () => {
    sendPrivateChatMessage(chatSession.id);
  });

  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendPrivateChatMessage(chatSession.id);
    }
  });

  // Store references
  window.currentPrivateChat = {
    sessionId: chatSession.id,
    panel: chatPanel,
    input: chatInput,
    messages: chatMessages,
    userInfo,
    displayedMessageIds: new Set(),
    isWaiting: isWaiting
  };

  // Start polling for messages
  startPrivateChatMessagePolling(chatSession.id, userInfo);
}

// Send private chat message
async function sendPrivateChatMessage(sessionId) {
  if (!window.currentPrivateChat) return;

  const { input, userInfo } = window.currentPrivateChat;
  const message = input.value.trim();

  if (!message) return;

  try {
    const response = await fetch('/api/chat/private/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        username: userInfo.username,
        gender: userInfo.gender,
        message
      })
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Session has ended
        handlePrivateChatEnded('El chat ha terminado.');
        return;
      }
      throw new Error('Failed to send message');
    }

    // Clear input
    input.value = '';

    // Add message locally
    addPrivateChatMessage({
      id: `temp_${userInfo.username}_${message}_${Date.now()}`,
      username: userInfo.username,
      gender: userInfo.gender,
      message,
      timestamp: new Date().toISOString(),
      isOwn: true
    });

  } catch (error) {
    console.error('Error sending private message:', error);
    if (error.message.includes('fetch') || error.name === 'TypeError') {
      handlePrivateChatEnded('Error de conexión. El chat puede haber terminado.');
    } else {
      alert('Error al enviar mensaje.');
    }
  }
}

// Add message to private chat
function addPrivateChatMessage(msg) {
  if (!window.currentPrivateChat) return;

  const { messages, displayedMessageIds } = window.currentPrivateChat;

  // Check for duplicates
  const messageId = msg.id || `${msg.username}_${msg.timestamp}_${msg.message}`;
  if (displayedMessageIds.has(messageId)) {
    return;
  }

  displayedMessageIds.add(messageId);

  const messageEl = document.createElement('div');
  messageEl.className = `chat-message ${msg.isOwn ? 'own' : 'other'}`;

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  const displayName = msg.isOwn ? 'Tú' : msg.username;

  messageEl.innerHTML = `
    <div class="message-header">
      <span class="message-username">${displayName}</span>
      <span class="message-gender">${msg.gender === 'M' ? '♂️' : '♀️'}</span>
      <span class="message-time">${time}</span>
    </div>
    <div class="message-text">${escapeHtml(msg.message)}</div>
  `;

  messages.appendChild(messageEl);
  messages.scrollTop = messages.scrollHeight;
}

// Start polling for private chat messages
function startPrivateChatMessagePolling(sessionId, userInfo) {
  if (window.privateChatPollingInterval) {
    clearInterval(window.privateChatPollingInterval);
  }

  window.privateChatPollingInterval = setInterval(async () => {
    if (!window.currentPrivateChat) {
      clearInterval(window.privateChatPollingInterval);
      return;
    }

    try {
      const response = await fetch(`/api/chat/private/messages/${sessionId}`);
      if (!response.ok) {
        // If session not found or ended, the chat has ended
        if (response.status === 404) {
          const errorData = await response.json().catch(() => ({}));
          if (errorData.ended) {
            handlePrivateChatEnded('El chat ha terminado porque el otro usuario se desconectó.');
          } else {
            handlePrivateChatEnded('El chat ha terminado.');
          }
        }
        return;
      }

      const data = await response.json();

      // Check if session is still active
      if (!data.active) {
        handlePrivateChatEnded('El chat ha terminado.');
        return;
      }

      const messages = data.messages || [];

      // Check if we were waiting and now have a second user
      if (window.currentPrivateChat.isWaiting && messages.length > 0) {
        // Update welcome message
        const welcomeDiv = window.currentPrivateChat.messages.querySelector('.chat-welcome');
        if (welcomeDiv) {
          welcomeDiv.innerHTML = '<p>¡Usuario conectado!</p><p>Ya pueden chatear...</p>';
        }
        window.currentPrivateChat.isWaiting = false;
      }

      // Add new messages
      messages.forEach(msg => {
        const isOwn = msg.username === userInfo.username;
        const messageId = msg.id || `${msg.username}_${msg.timestamp}_${msg.message}`;

        if (!window.currentPrivateChat.displayedMessageIds.has(messageId)) {
          window.currentPrivateChat.displayedMessageIds.add(messageId);
          addPrivateChatMessage({
            id: messageId,
            username: msg.username,
            gender: msg.gender,
            message: msg.message,
            timestamp: msg.timestamp,
            isOwn
          });
        }
      });

    } catch (error) {
      console.error('Error polling private messages:', error);
      // If network error persists, assume chat ended
      if (error.name === 'TypeError' || error.message.includes('fetch')) {
        handlePrivateChatEnded('Error de conexión. El chat puede haber terminado.');
      }
    }
  }, 2000); // Poll every 2 seconds
}

// Handle private chat ended
function handlePrivateChatEnded(reason) {
  if (!window.currentPrivateChat) return;

  const { panel } = window.currentPrivateChat;

  // Stop polling
  if (window.privateChatPollingInterval) {
    clearInterval(window.privateChatPollingInterval);
    window.privateChatPollingInterval = null;
  }

  // Add system message
  addPrivateChatMessage({
    username: 'Sistema',
    gender: 'N',
    message: reason,
    timestamp: new Date().toISOString(),
    isOwn: false
  });

  // Auto-leave after a delay
  setTimeout(() => {
    if (window.currentPrivateChat) {
      leavePrivateChat(window.currentPrivateChat.sessionId);
    }
  }, 3000);

  console.log('Private chat ended:', reason);
}

// Leave private chat
async function leavePrivateChat(sessionId) {
  if (!window.currentPrivateChat) return;

  const { panel } = window.currentPrivateChat;

  try {
    // Notify server
    await fetch('/api/chat/private/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
  } catch (error) {
    console.error('Error leaving private chat:', error);
  }

  // Stop polling
  if (window.privateChatPollingInterval) {
    clearInterval(window.privateChatPollingInterval);
    window.privateChatPollingInterval = null;
  }

  // Remove chat panel
  panel.classList.remove('show');
  setTimeout(() => {
    panel.remove();
  }, 300);

  // Clear data
  if (window.currentPrivateChat && window.currentPrivateChat.displayedMessageIds) {
    window.currentPrivateChat.displayedMessageIds.clear();
  }
  window.currentPrivateChat = null;

  console.log('Left private chat');
}

// Open private chat setup modal
function openPrivateChatSetupModal(chatRoomId, isCreating = false) {
  const modalTitle = isCreating ? 'Crear Chat Privado' : 'Unirse al Chat Privado';
  const modalDescription = isCreating
    ? 'Estás creando un chat privado. Espera a que alguien se conecte.'
    : 'Estás a punto de unirte a un chat privado. Solo tú y la otra persona podrán ver los mensajes.';
  const buttonText = isCreating ? 'Crear chat' : 'Unirme al chat';

  const savedUserData = localStorage.getItem('privateChatUserData');
  let savedUsername = '';
  let savedGender = '';

  if (savedUserData) {
    try {
      const userData = JSON.parse(savedUserData);
      savedUsername = userData.username || '';
      savedGender = userData.gender || '';
    } catch (error) {
      console.error('Error parsing saved private chat user data:', error);
    }
  }

  const modalHTML = `
    <div id="private-chat-setup-modal" class="chat-setup-modal">
      <div class="chat-setup-modal-content">
        <div class="chat-setup-modal-header">
          <h2>${modalTitle}</h2>
          <button id="private-chat-setup-modal-close" class="chat-setup-modal-close">&times;</button>
        </div>
        <div class="chat-setup-modal-body">
          <p class="chat-setup-description">
            ${modalDescription}
          </p>

          <div class="chat-setup-form">
            <div class="form-group">
              <label for="private-chat-username">Nombre de usuario:</label>
              <input
                type="text"
                id="private-chat-username"
                placeholder="Tu nombre o alias"
                maxlength="20"
                autocomplete="off"
                value="${savedUsername}"
                required
              />
            </div>

            <div class="form-group">
              <label>Género:</label>
              <div class="gender-options">
                <label class="gender-option">
                  <input type="radio" name="private-gender" value="M" ${savedGender === 'M' ? 'checked' : ''} required />
                  <span class="gender-label">Masculino</span>
                </label>
                <label class="gender-option">
                  <input type="radio" name="private-gender" value="F" ${savedGender === 'F' ? 'checked' : ''} required />
                  <span class="gender-label">Femenino</span>
                </label>
              </div>
            </div>

            <div class="chat-setup-actions">
              <button id="private-chat-setup-cancel" class="chat-setup-btn cancel">Cancelar</button>
              <button id="private-chat-setup-join" class="chat-setup-btn primary">${buttonText}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const modal = document.getElementById("private-chat-setup-modal");
  const closeBtn = document.getElementById("private-chat-setup-modal-close");
  const cancelBtn = document.getElementById("private-chat-setup-cancel");
  const joinBtn = document.getElementById("private-chat-setup-join");
  const usernameInput = document.getElementById("private-chat-username");

  setTimeout(() => {
    modal.classList.add('show');
    if (savedUsername) {
      joinBtn.focus();
    } else {
      usernameInput.focus();
    }
  }, 100);

  const closeModal = () => {
    modal.remove();
  };

  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
    }
  });

  joinBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    const gender = document.querySelector('input[name="private-gender"]:checked')?.value;

    if (!username) {
      alert("Por favor ingresa un nombre de usuario");
      usernameInput.focus();
      return;
    }

    if (!gender) {
      alert("Por favor selecciona tu género");
      return;
    }

    // Save user data
    const userData = { username, gender };
    localStorage.setItem('privateChatUserData', JSON.stringify(userData));
    localStorage.setItem('privateChatUserInfo', JSON.stringify(userData));

    if (isCreating) {
      // Create new chat
      createPrivateChat();
    } else {
      // Join existing chat
      joinPrivateChat(chatRoomId);
    }
    closeModal();
  });
}

// Open chat setup modal for username and gender selection
function openChatSetupModal() {
  console.log('Opening chat setup modal');

  // Load saved user data from localStorage
  const savedUserData = localStorage.getItem('chatUserData');
  let savedUsername = '';
  let savedGender = '';

  if (savedUserData) {
    try {
      const userData = JSON.parse(savedUserData);
      savedUsername = userData.username || '';
      savedGender = userData.gender || '';
    } catch (error) {
      console.error('Error parsing saved user data:', error);
    }
  }

  // Create modal HTML
  const modalHTML = `
    <div id="chat-setup-modal" class="chat-setup-modal">
      <div class="chat-setup-modal-content">
        <div class="chat-setup-modal-header">
          <h2>Chatear en esta zona</h2>
          <button id="chat-setup-modal-close" class="chat-setup-modal-close">&times;</button>
        </div>
        <div class="chat-setup-modal-body">
          <p class="chat-setup-description">
            Únete al chat grupal de esta área. Todas las personas que estén en esta zona podrán verte y chatear contigo.
          </p>

          <div class="chat-setup-form">
            <div class="form-group">
              <label for="chat-username">Nombre de usuario:</label>
              <input
                type="text"
                id="chat-username"
                placeholder="Tu nombre o alias"
                maxlength="20"
                autocomplete="off"
                value="${savedUsername}"
                required
              />
            </div>

            <div class="form-group">
              <label>Género:</label>
              <div class="gender-options">
                <label class="gender-option">
                  <input type="radio" name="gender" value="M" ${savedGender === 'M' ? 'checked' : ''} required />
                  <span class="gender-label">Masculino</span>
                </label>
                <label class="gender-option">
                  <input type="radio" name="gender" value="F" ${savedGender === 'F' ? 'checked' : ''} required />
                  <span class="gender-label">Femenino</span>
                </label>
              </div>
            </div>

            <div class="chat-setup-actions">
              <button id="chat-setup-cancel" class="chat-setup-btn cancel">Cancelar</button>
              <button id="chat-setup-join" class="chat-setup-btn primary">Unirme al chat</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Add modal to body
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  // Get modal elements
  const modal = document.getElementById("chat-setup-modal");

  // Show modal
  setTimeout(() => {
    modal.classList.add('show');
  }, 100);
  const closeBtn = document.getElementById("chat-setup-modal-close");
  const cancelBtn = document.getElementById("chat-setup-cancel");
  const joinBtn = document.getElementById("chat-setup-join");
  const usernameInput = document.getElementById("chat-username");

  // Focus on username input if no saved data, otherwise focus on join button
  setTimeout(() => {
    if (savedUsername) {
      joinBtn.focus();
    } else {
      usernameInput.focus();
    }
  }, 100);

  // Close modal functions
  const closeModal = () => {
    modal.remove();
  };

  // Event listeners
  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
    }
  });

  // Join chat function
  joinBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    const gender = document.querySelector('input[name="gender"]:checked')?.value;

    if (!username) {
      alert("Por favor ingresa un nombre de usuario");
      usernameInput.focus();
      return;
    }

    if (!gender) {
      alert("Por favor selecciona tu género");
      return;
    }

    // Save user data to localStorage
    const userData = { username, gender };
    localStorage.setItem('chatUserData', JSON.stringify(userData));

    // Join the chat
    joinChatZone(username, gender);
    closeModal();
  });
}

// Load and update donation progress
async function loadDonationProgress() {
  try {
    const response = await fetch("/api/payments/progress");
    const data = await response.json();

    // Update side panel progress bar
    const progressFill = document.getElementById("progress-fill");
    const currentAmount = document.getElementById("current-amount");
    const progressPercentage = document.getElementById("progress-percentage");

    if (progressFill && currentAmount && progressPercentage) {
      progressFill.style.width = `${data.percentage}%`;
      currentAmount.textContent = data.total.toFixed(2);
      progressPercentage.textContent = `${data.percentage}%`;
    }

    // Update modal progress bar
    const modalProgressFill = document.getElementById("modal-progress-fill");
    const modalCurrentAmount = document.getElementById("modal-current-amount");
    const modalProgressPercentage = document.getElementById(
      "modal-progress-percentage"
    );

    if (modalProgressFill && modalCurrentAmount && modalProgressPercentage) {
      modalProgressFill.style.width = `${data.percentage}%`;
      modalCurrentAmount.textContent = data.total.toFixed(2);
      modalProgressPercentage.textContent = `${data.percentage}%`;
    }
  } catch (error) {
    console.error("Error loading donation progress:", error);
  }
}

// Join chat zone with username and gender
async function joinChatZone(username, gender) {
  try {
    // Get current map bounds to determine the chat zone
    const bounds = map.getBounds();
    const center = map.getCenter();
    const zoom = map.getZoom();

    // Create zone identifier based on current view (rounded to larger grid for better matching)
    // Round to 0.5 degrees (~55km) for much larger zones and ignore zoom level for broader matching
    const zoneId = `${center.lat.toFixed(1)}_${center.lng.toFixed(1)}`;

    // Join via API
    console.log('Joining chat zone:', zoneId);
    const response = await fetch('/api/chat/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, gender, zoneId })
    });

    console.log('Join response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Join error:', errorText);
      throw new Error('Failed to join chat zone');
    }

    const data = await response.json();
    console.log('Join response data:', data);

    // Store user info in localStorage for persistence
    const userInfo = {
      userId: data.userId,
      username,
      gender,
      zoneId,
      joinedAt: new Date().toISOString()
    };
    localStorage.setItem('chatUserInfo', JSON.stringify(userInfo));

    // Open chat interface
    openChatInterface(userInfo);

    // Update chat zone marker count
    updateChatZoneMarkerCount(zoneId, data.usersInZone.length);

    // Change button to indicate active chat
    if (chatZoneButton) {
      chatZoneButton.innerHTML = '<i class="fas fa-comments"></i>';
      chatZoneButton.classList.add('active');
      chatZoneButton.title = `Chateando como ${username} - Haz clic para salir`;
    }

    // Load existing messages (limit to 5 initially)
    loadChatMessages(userInfo, 5);

    // Start polling for new messages
    startMessagePolling(userInfo);

    // Start polling for user count updates
    startUserCountPolling(userInfo);

    console.log(`Joined chat zone: ${zoneId} as ${username} (${gender})`);

  } catch (error) {
    console.error('Error joining chat zone:', error);
    alert('Error al unirse al chat. Inténtalo de nuevo.');
  }
}

// Open chat interface
function openChatInterface(userInfo) {
  // Create chat panel HTML
  const chatHTML = `
    <div id="chat-panel" class="chat-panel">
      <div class="chat-header">
        <div class="chat-zone-info">
          <i class="fas fa-map-marker-alt"></i>
          <span>Chat de zona</span>
        </div>
        <div class="chat-user-info">
          <span class="chat-username">${userInfo.username}</span>
          <span class="chat-gender">${userInfo.gender === 'M' ? '♂️' : '♀️'}</span>
        </div>
        <button id="chat-close" class="chat-close-btn" title="Salir del chat">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-welcome">
          <p>¡Bienvenido al chat de esta zona!</p>
          <p>Conectando con otras personas...</p>
        </div>
        <div class="load-more-messages" id="load-more-messages" style="display: none;">
          <button class="load-more-btn" id="load-more-btn">Cargar más mensajes</button>
        </div>
      </div>
      <div class="chat-input-area">
        <input
          type="text"
          id="chat-input"
          placeholder="Escribe un mensaje..."
          maxlength="200"
          autocomplete="off"
        />
        <button id="chat-send" class="chat-send-btn">
          <i class="fas fa-paper-plane"></i>
        </button>
      </div>
    </div>
  `;

  // Add chat panel to body
  document.body.insertAdjacentHTML('beforeend', chatHTML);

  // Get chat elements
  const chatPanel = document.getElementById("chat-panel");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const chatClose = document.getElementById("chat-close");
  const chatMessages = document.getElementById("chat-messages");
  const loadMoreMessages = document.getElementById("load-more-messages");
  const loadMoreBtn = document.getElementById("load-more-btn");

  // Show chat panel with animation
  setTimeout(() => {
    chatPanel.classList.add('show');
  }, 100);

  // Focus on input
  setTimeout(() => chatInput.focus(), 300);

  // Event listeners
  chatClose.addEventListener("click", () => {
    leaveChatZone();
  });

  chatSend.addEventListener("click", () => {
    sendChatMessage();
  });

  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendChatMessage();
    }
  });

  // Load more messages functionality
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", async () => {
      if (!window.currentChat) return;

      const { userInfo } = window.currentChat;
      const currentLoaded = window.currentChat.loadedMessages || 0;

      // Load next batch of messages (20 more)
      await loadChatMessages(userInfo, currentLoaded + 20);

      // Update load more button visibility
      updateLoadMoreButtonVisibility();
    });
  }

  // Store references for later use
  window.currentChat = {
    userInfo,
    panel: chatPanel,
    input: chatInput,
    messages: chatMessages,
    loadMoreMessages,
    displayedMessageIds: new Set() // Track displayed message IDs to prevent duplicates
  };
}

// Send chat message
async function sendChatMessage() {
  if (!window.currentChat) return;

  const { input, userInfo } = window.currentChat;
  const message = input.value.trim();

  if (!message) return;

  try {
    console.log('Sending message:', message);
    // Send message to server
    const response = await fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userInfo.userId,
        zoneId: userInfo.zoneId,
        message
      })
    });

    console.log('Send message response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Send message error:', errorText);
      throw new Error('Failed to send message');
    }

    // Clear input immediately for better UX
    input.value = '';

    // Add message to chat locally after a small delay to let server respond first
    setTimeout(() => {
      const tempTimestamp = new Date().toISOString();
      addChatMessage({
        id: `temp_${userInfo.username}_${message}_${Date.now()}`,
        username: userInfo.username,
        gender: userInfo.gender,
        message,
        timestamp: tempTimestamp,
        isOwn: true
      });
    }, 100);

  } catch (error) {
    console.error('Error sending message:', error);
    alert('Error al enviar mensaje. Inténtalo de nuevo.');
  }
}

// Add message to chat
function addChatMessage(msg) {
  if (!window.currentChat) return;

  const { messages, displayedMessageIds } = window.currentChat;

  // Check for duplicate messages using multiple strategies
  const messageId = msg.id || `${msg.username}_${msg.timestamp}_${msg.message}`;

  // Also check for content-based duplicates (for messages sent by current user)
  const contentKey = `${msg.username}_${msg.message}_${new Date(msg.timestamp).getTime()}`;
  const tempContentKey = `temp_${msg.username}_${msg.message}`;

  if (displayedMessageIds.has(messageId) ||
      displayedMessageIds.has(contentKey) ||
      displayedMessageIds.has(tempContentKey)) {
    console.log('Skipping duplicate message:', messageId);
    return;
  }

  // Mark this message as displayed with multiple keys to prevent duplicates
  displayedMessageIds.add(messageId);
  displayedMessageIds.add(contentKey);
  if (msg.isOwn) {
    displayedMessageIds.add(tempContentKey);
  }

  const messageEl = document.createElement('div');
  messageEl.className = `chat-message ${msg.isOwn ? 'own' : 'other'}`;

  const time = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  // For own messages, show "Tú" instead of username
  const displayName = msg.isOwn ? 'Tú' : msg.username;

  messageEl.innerHTML = `
    <div class="message-header">
      <span class="message-username">${displayName}</span>
      <span class="message-gender">${msg.gender === 'M' ? '♂️' : '♀️'}</span>
      <span class="message-time">${time}</span>
    </div>
    <div class="message-text">${escapeHtml(msg.message)}</div>
  `;

  messages.appendChild(messageEl);
  messages.scrollTop = messages.scrollHeight;
}

// Load existing chat messages
async function loadChatMessages(userInfo, limit = 5) {
  try {
    const response = await fetch(`/api/chat/messages/${userInfo.zoneId}?userId=${userInfo.userId}&limit=${limit}`);
    if (!response.ok) return;

    const data = await response.json();
    const messages = data.messages || [];

    // Add messages to chat (identify which ones are from current user)
    messages.forEach(msg => {
      const isOwn = msg.userId === userInfo.userId;
      const messageId = msg.id || `${msg.username}_${msg.timestamp}_${msg.message}`;
      const contentKey = `${msg.username}_${msg.message}_${new Date(msg.timestamp).getTime()}`;

      // Mark these as displayed to prevent duplicates
      if (!window.currentChat.displayedMessageIds.has(messageId)) {
        window.currentChat.displayedMessageIds.add(messageId);
        window.currentChat.displayedMessageIds.add(contentKey);
      }

      addChatMessage({
        id: messageId,
        username: msg.username,
        gender: msg.gender,
        message: msg.message,
        timestamp: msg.timestamp,
        isOwn: isOwn
      });
    });

    // Set the last message time to the most recent message to prevent duplicates in polling
    if (messages.length > 0 && window.currentChat) {
      const latestMessage = messages.reduce((latest, msg) => {
        const msgTime = new Date(msg.timestamp).getTime();
        const latestTime = new Date(latest.timestamp).getTime();
        return msgTime > latestTime ? msg : latest;
      });
      window.currentChat.lastMessageTime = new Date(latestMessage.timestamp).getTime();
      console.log('Set last message time to:', new Date(window.currentChat.lastMessageTime));
    }

    // Store pagination info for loading more messages
    if (window.currentChat) {
      window.currentChat.totalMessages = data.total || messages.length;
      window.currentChat.loadedMessages = messages.length;
      window.currentChat.hasMoreMessages = data.hasMore || false;
    }

    // Update load more button visibility
    updateLoadMoreButtonVisibility();

  } catch (error) {
    console.error('Error loading chat messages:', error);
  }
}

// Start polling for new messages
function startMessagePolling(userInfo) {
  if (window.messagePollingInterval) {
    clearInterval(window.messagePollingInterval);
  }

  // Initialize last message time if not set
  if (!window.currentChat.lastMessageTime) {
    window.currentChat.lastMessageTime = Date.now();
  }

  // Add a small random delay to prevent all clients from polling at the same time
  const pollDelay = Math.random() * 1000; // 0-1 second random delay

  setTimeout(() => {
    window.messagePollingInterval = setInterval(async () => {
      if (!window.currentChat) {
        clearInterval(window.messagePollingInterval);
        return;
      }

      try {
        const response = await fetch(`/api/chat/messages/${userInfo.zoneId}?userId=${userInfo.userId}`);
        if (!response.ok) {
          console.error('Message polling failed:', response.status);
          return;
        }

        const data = await response.json();
        const messages = data.messages || [];

        // Get the last message timestamp we have
        const lastMessageTime = window.currentChat.lastMessageTime || 0;

        // Filter and add only new messages (not already displayed)
        const newMessages = messages.filter(msg => {
          const msgTime = new Date(msg.timestamp).getTime();
          const messageId = msg.id || `${msg.username}_${msg.timestamp}_${msg.message}`;
          const contentKey = `${msg.username}_${msg.message}_${msgTime}`;
          const isNew = msgTime > lastMessageTime;
          const notDisplayed = !window.currentChat.displayedMessageIds.has(messageId) &&
                              !window.currentChat.displayedMessageIds.has(contentKey);

          return isNew && notDisplayed;
        });

        // Add new messages in chronological order
        newMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        newMessages.forEach(msg => {
          const isOwn = msg.userId === userInfo.userId;
          console.log('Adding new polled message from', msg.username, ':', msg.message, isOwn ? '(own)' : '(other)');
          addChatMessage({
            id: msg.id,
            username: msg.username,
            gender: msg.gender,
            message: msg.message,
            timestamp: msg.timestamp,
            isOwn: isOwn
          });
        });

        // Update last message time to the latest message we received
        if (messages.length > 0) {
          // Find the most recent message timestamp
          const latestMessage = messages.reduce((latest, msg) => {
            const msgTime = new Date(msg.timestamp).getTime();
            const latestTime = new Date(latest.timestamp).getTime();
            return msgTime > latestTime ? msg : latest;
          });
          window.currentChat.lastMessageTime = new Date(latestMessage.timestamp).getTime();
        }

        // Clean up old message IDs to prevent memory leaks (keep only last 100)
        if (window.currentChat.displayedMessageIds.size > 100) {
          const idsArray = Array.from(window.currentChat.displayedMessageIds);
          const keepIds = idsArray.slice(-50); // Keep last 50
          window.currentChat.displayedMessageIds = new Set(keepIds);
        }

      } catch (error) {
        console.error('Error polling messages:', error);
      }
    }, 3000); // Poll every 3 seconds
  }, pollDelay);
}

// Start polling for user count updates
function startUserCountPolling(userInfo) {
  if (window.userCountPollingInterval) {
    clearInterval(window.userCountPollingInterval);
  }

  window.userCountPollingInterval = setInterval(async () => {
    if (!window.currentChat) {
      clearInterval(window.userCountPollingInterval);
      return;
    }

    try {
      const response = await fetch(`/api/chat/users/${userInfo.zoneId}`);
      if (!response.ok) return;

      const data = await response.json();
      updateUserCount(data.count);

    } catch (error) {
      console.error('Error polling user count:', error);
    }
  }, 10000); // Poll every 10 seconds
}

// Update user count in chat header
function updateUserCount(count) {
  if (!window.currentChat) return;

  const { panel } = window.currentChat;
  const header = panel.querySelector('.chat-header');
  const zoneInfo = header.querySelector('.chat-zone-info');

  // Update the zone info to show user count
  zoneInfo.innerHTML = `
    <i class="fas fa-map-marker-alt"></i>
    <span>Chat de zona (${count} usuarios en línea)</span>
  `;
}

// Leave chat zone
async function leaveChatZone() {
  if (!window.currentChat) return;

  const { panel, userInfo } = window.currentChat;

  try {
    // Leave via API
    await fetch('/api/chat/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userInfo.userId,
        zoneId: userInfo.zoneId
      })
    });
  } catch (error) {
    console.error('Error leaving chat zone:', error);
  }

  // Stop message polling
  if (window.messagePollingInterval) {
    clearInterval(window.messagePollingInterval);
    window.messagePollingInterval = null;
  }

  // Stop user count polling
  if (window.userCountPollingInterval) {
    clearInterval(window.userCountPollingInterval);
    window.userCountPollingInterval = null;
  }

  // Remove chat panel
  panel.classList.remove('show');
  setTimeout(() => {
    panel.remove();
  }, 300);

  // Update chat zone marker count
  if (userInfo && userInfo.zoneId) {
    // Get updated user count for the zone
    try {
      const response = await fetch(`/api/chat/users/${userInfo.zoneId}`);
      if (response.ok) {
        const data = await response.json();
        updateChatZoneMarkerCount(userInfo.zoneId, data.count);
      }
    } catch (error) {
      console.error('Error updating chat zone marker count:', error);
    }
  }

  // Clear user info
  localStorage.removeItem('chatUserInfo');
  if (window.currentChat && window.currentChat.displayedMessageIds) {
    window.currentChat.displayedMessageIds.clear();
  }
  window.currentChat = null;

  // Reset button
  if (chatZoneButton) {
    chatZoneButton.innerHTML = '<i class="fas fa-comments"></i>';
    chatZoneButton.classList.remove('active');
    chatZoneButton.title = 'Chatear en esta zona (zoom mínimo: 14)';
  }

  console.log('Left chat zone');
}

// Check if user is still in their chat zone
function checkChatZoneProximity() {
  if (!window.currentChat) return;

  const userInfo = window.currentChat.userInfo;
  const currentCenter = map.getCenter();
  const currentZoom = map.getZoom();

  // Calculate current zone
  const currentZoneId = `${currentCenter.lat.toFixed(1)}_${currentCenter.lng.toFixed(1)}`;

  // Check if user moved to a different zone
  if (currentZoneId !== userInfo.zoneId) {
    console.log('User moved away from chat zone, disconnecting...');

    // Add system message
    addChatMessage({
      username: 'Sistema',
      gender: 'N',
      message: 'Te has alejado de la zona de chat. Desconectando...',
      timestamp: new Date().toISOString(),
      isOwn: false
    });

    // Disconnect after a short delay
    setTimeout(() => {
      leaveChatZone();
    }, 2000);
  }
}

// Check for nearby active chats
async function checkNearbyChats() {
  if (!chatZoneButton || !map) return;

  try {
    const center = map.getCenter();
    const zoneId = `${center.lat.toFixed(1)}_${center.lng.toFixed(1)}`;

    const response = await fetch(`/api/chat/users/${zoneId}`);
    if (!response.ok) return;

    const data = await response.json();
    const userCount = data.count || 0;

    // Update button appearance based on user count
    updateChatButtonForUsers(userCount);

  } catch (error) {
    console.error('Error checking nearby chats:', error);
  }
}

// Update chat button appearance based on user count
function updateChatButtonForUsers(userCount) {
  if (!chatZoneButton) return;

  if (userCount > 1) {
    // Active chat with multiple users
    chatZoneButton.classList.add('has-users');
    chatZoneButton.title = `Chatear en esta zona (${userCount} usuarios en línea)`;
  } else if (userCount === 1) {
    // Only current user
    chatZoneButton.classList.remove('has-users');
    chatZoneButton.title = 'Chatear en esta zona (solo tú)';
  } else {
    // No users
    chatZoneButton.classList.remove('has-users');
    chatZoneButton.title = 'Chatear en esta zona (sin usuarios)';
  }
}

// Start periodic chat zones refresh
function startChatZonesRefresh() {
  // Refresh chat zones every 30 seconds
  setInterval(async () => {
    if (map && map.getZoom() >= 8) { // Only refresh if zoom level allows markers
      await loadChatZones();
      // Update visibility after refresh
      updateChatZoneMarkersVisibility();
    }
  }, 30000); // 30 seconds
}

// Update load more messages button visibility
function updateLoadMoreButtonVisibility() {
  if (!window.currentChat || !window.currentChat.loadMoreMessages) return;

  const { loadMoreMessages, hasMoreMessages, loadedMessages, totalMessages } = window.currentChat;

  if (hasMoreMessages && loadedMessages < totalMessages) {
    loadMoreMessages.style.display = 'block';
  } else {
    loadMoreMessages.style.display = 'none';
  }
}

// Handle page unload to leave chats
window.addEventListener('beforeunload', () => {
  // Leave zone chat if active
  if (window.currentChat) {
    // Try to leave synchronously (though it may not complete)
    navigator.sendBeacon('/api/chat/leave', JSON.stringify({
      userId: window.currentChat.userInfo.userId,
      zoneId: window.currentChat.userInfo.zoneId
    }));
  }

  // Leave private chat if active
  if (window.currentPrivateChat) {
    navigator.sendBeacon('/api/chat/private/leave', JSON.stringify({
      sessionId: window.currentPrivateChat.sessionId
    }));
  }
});

// Handle visibility change to detect when user switches tabs or minimizes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // User left the page
    console.log('User left the page');
  } else {
    // User returned to the page
    console.log('User returned to the page');
  }
});

// Restore chat session from localStorage
function restoreChatSession() {
  const storedUserInfo = localStorage.getItem('chatUserInfo');
  if (!storedUserInfo) return;

  try {
    const userInfo = JSON.parse(storedUserInfo);

    // Check if session is still valid (not too old)
    const joinedAt = new Date(userInfo.joinedAt);
    const now = new Date();
    const hoursSinceJoin = (now - joinedAt) / (1000 * 60 * 60);

    if (hoursSinceJoin > 24) { // Session expires after 24 hours
      localStorage.removeItem('chatUserInfo');
      return;
    }

    // Check if still in the same zone
    const currentCenter = map.getCenter();
    const currentZoneId = `${currentCenter.lat.toFixed(1)}_${currentCenter.lng.toFixed(1)}`;

    // Check if in the same zone
    if (currentZoneId !== userInfo.zoneId) {
      localStorage.removeItem('chatUserInfo');
      return;
    }

    // Restore the chat
    console.log('Restoring chat session for:', userInfo.username);
    openChatInterface(userInfo);

    // Update button state
    if (chatZoneButton) {
      chatZoneButton.innerHTML = '<i class="fas fa-comments"></i>';
      chatZoneButton.classList.add('active');
      chatZoneButton.title = `Chateando como ${userInfo.username} - Haz clic para salir`;
    }

    // Load existing messages and start polling (limit to 5 initially)
    loadChatMessages(userInfo, 5);
    startMessagePolling(userInfo);
    startUserCountPolling(userInfo);

    // Add welcome back message
    setTimeout(() => {
      addChatMessage({
        username: 'Sistema',
        gender: 'N',
        message: `¡Bienvenido de vuelta, ${userInfo.username}!`,
        timestamp: new Date().toISOString(),
        isOwn: false
      });
    }, 1000);

  } catch (error) {
    console.error('Error restoring chat session:', error);
    localStorage.removeItem('chatUserInfo');
  }
}
