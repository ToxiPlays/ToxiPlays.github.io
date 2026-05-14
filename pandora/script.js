let albums = [];
let currentAlbum = null;
let albumsDb;
let currentTrackIndex = -1;
let wavesurfer = null;
let preloadWavesurfer = null;
let loadStartTime = 0;
let loadDuration = 0;
let isShuffled = false;
let repeatMode = 'none'; // none, track, album
let originalOrder = [];
let settings = { defaultProducers: '', defaultWriters: '', customTags: [], nicheMode: false };
let currentLyrics = null;
let lyricsAnimationFrameId = null;

const savedSettings = localStorage.getItem('settings');
if (savedSettings) {
    Object.assign(settings, JSON.parse(savedSettings));
}

const albumsDbRequest = indexedDB.open('AlbumsMetaDB', 1);
albumsDbRequest.onupgradeneeded = (event) => {
    albumsDb = event.target.result;
    if (!albumsDb.objectStoreNames.contains('albums')) {
        albumsDb.createObjectStore('albums', { keyPath: 'id' });
    }
};
albumsDbRequest.onsuccess = (event) => {
    albumsDb = event.target.result;
    migrateAlbumsFromLocalStorageIfNeeded().then(() => {
        loadAlbumsFromDb();
    });
};
albumsDbRequest.onerror = (event) => {
    console.error('Albums IndexedDB error:', event.target.error);
};

async function migrateAlbumsFromLocalStorageIfNeeded() {
    const localAlbums = localStorage.getItem('albums');
    if (localAlbums) {
        try {
            const parsed = JSON.parse(localAlbums);
            if (Array.isArray(parsed)) {
                for (const album of parsed) {
                    await saveAlbumToDb(album);
                }
                localStorage.removeItem('albums');
                console.log('Migrated albums from localStorage to IndexedDB.');
            }
        } catch (e) {
            console.error('Error migrating albums:', e);
        }
    }
}

function saveAlbumToDb(album) {
    return new Promise((resolve, reject) => {
        const tx = albumsDb.transaction(['albums'], 'readwrite');
        const store = tx.objectStore('albums');
        store.put(album);
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

function deleteAlbumFromDb(albumId) {
    return new Promise((resolve, reject) => {
        const tx = albumsDb.transaction(['albums'], 'readwrite');
        const store = tx.objectStore('albums');
        store.delete(albumId);
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

function loadAlbumsFromDb() {
    const tx = albumsDb.transaction(['albums'], 'readonly');
    const store = tx.objectStore('albums');
    const req = store.getAll();
    req.onsuccess = () => {
        albums = req.result || [];
        loadFilesForAlbums();
    };
    req.onerror = (e) => {
        console.error('Error loading albums from db:', e);
    };
}

// Check if first visit
if (!localStorage.getItem('hasSeenHelp')) {
    setTimeout(()=>{
        document.getElementById('help-modal').classList.remove('hidden');
        document.getElementById('help-modal').classList.add('show');
        localStorage.setItem('hasSeenHelp', 'true');
    }, 500);
}

let db;
const dbRequest = indexedDB.open('AlbumTracksDB', 1);
dbRequest.onupgradeneeded = (event) => {
    db = event.target.result;
    if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files');
    }
};
dbRequest.onsuccess = (event) => {
    db = event.target.result;
    loadFilesForAlbums();
};
dbRequest.onerror = (event) => {
    console.error('IndexedDB error:', event.target.error);
};

function storeFile(key, file) {
    const transaction = db.transaction(['files'], 'readwrite');
    const store = transaction.objectStore('files');
    store.put(file, key);
}

// Map agent IDs (v1, v2, v3, etc.) to highlight colors
const agentColors = {
    v1: '#0087ff',      // Current (blue)
    v2: '#ff1493',      // Hot pink
    v3: '#6a0dad',      // Deep purple
    v4: '#c27210',      // Orange
    v5: '#006400',      // Dark green
    v6: '#8b4513',      // Brown
};

function getAgentColor(agent) {
    if (agentColors[agent]) {
        return agentColors[agent];
    }
    
    // Extract version number and loop
    const match = agent.match(/v(\d+)/);
    if (match) {
        const versionNum = parseInt(match[1]);
        const colorArray = ['#0087ff', '#ff1493', '#6a0dad', '#ffff99', '#006400', '#8b4513'];
        const loopedIndex = ((versionNum - 1) % colorArray.length);
        return colorArray[loopedIndex];
    }
    
    return '#0087ff'; // Default fallback
}

function loadTTML(ttmlKey) {
    getFile(ttmlKey).then(file => {
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const parser = new DOMParser();
                    const xmlDoc = parser.parseFromString(e.target.result, 'text/xml');
                    
                    if (xmlDoc.getElementsByTagName('parsererror').length) {
                        console.error('Error parsing TTML file');
                        return;
                    }
                    
                    // Load agent names from metadata
                    const agentNames = {};
                    const agents = xmlDoc.getElementsByTagNameNS('http://www.w3.org/ns/ttml#metadata', 'agent');
                    Array.from(agents).forEach(agent => {
                        const agentId = agent.getAttribute('xml:id');
                        if (agentId) {
                            const nameEl = agent.getElementsByTagNameNS('http://www.w3.org/ns/ttml#metadata', 'name')[0];
                            if (nameEl) {
                                agentNames[agentId] = nameEl.textContent.trim();
                                console.log(`Found agent: ${agentId} = ${nameEl.textContent.trim()}`);
                            }
                        }
                    });
                    
                    const paragraphs = xmlDoc.querySelectorAll('p');
                    currentLyrics = [];
                    
                    paragraphs.forEach(p => {
                        const begin = p.getAttribute('begin');
                        const end = p.getAttribute('end');
                        const agent = p.getAttribute('ttm:agent') || 'v1';
                        
                        if (begin && end) {
                            // Parse child nodes preserving text nodes for proper spacing (syllable sync)
                            const mainSpans = [];
                            const bgSpans = [];
                            
                            // Walk the DOM, collecting spans and text nodes to preserve spacing
                            for (let i = 0; i < p.childNodes.length; i++) {
                                const node = p.childNodes[i];
                                if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'span') {
                                    const spanBegin = node.getAttribute('begin');
                                    const spanEnd = node.getAttribute('end');
                                    
                                    if (node.getAttribute('ttm:role') === 'x-bg') {
                                        // This is an ad-lib wrapper - extract only direct span children
                                        const bgChildren = Array.from(node.children).filter(child => child.tagName === 'span');
                                        for (let bgIdx = 0; bgIdx < bgChildren.length; bgIdx++) {
                                            const bgChild = bgChildren[bgIdx];
                                            const bgChildBegin = bgChild.getAttribute('begin');
                                            const bgChildEnd = bgChild.getAttribute('end');
                                            const nextBgSibling = bgChildren[bgIdx + 1];
                                            const hasTrailingSpace = nextBgSibling !== undefined;
                                            
                                            if (bgChildBegin && bgChildEnd) {
                                                bgSpans.push({
                                                    text: bgChild.textContent,
                                                    begin: parseTimeToSeconds(bgChildBegin),
                                                    end: parseTimeToSeconds(bgChildEnd),
                                                    isBackground: true,
                                                    hasTrailingSpace: hasTrailingSpace
                                                });
                                            }
                                        }
                                        }
                                    } else if (!node.getAttribute('ttm:role') && spanBegin && spanEnd) {
                                        // Check if next sibling is a text node with whitespace
                                        const nextNode = p.childNodes[i + 1];
                                        const hasTrailingSpace = nextNode && nextNode.nodeType === Node.TEXT_NODE && /\s/.test(nextNode.textContent);
                                        
                                        mainSpans.push({
                                            text: node.textContent,
                                            begin: parseTimeToSeconds(spanBegin),
                                            end: parseTimeToSeconds(spanEnd),
                                            isBackground: false,
                                            hasTrailingSpace: hasTrailingSpace
                                        });
                                    }
                                }
                            }
                            
                            currentLyrics.push({
                                mainSpans: mainSpans,
                                bgSpans: bgSpans,
                                begin: parseTimeToSeconds(begin),
                                end: parseTimeToSeconds(end),
                                agent: agent,
                                agentName: agentNames[agent] || null
                            });
                        }
                    });
                    
                    document.getElementById('synced-lyrics').classList.remove('hidden');
                } catch (error) {
                    console.error('Error processing TTML:', error);
                }
            };
            reader.onerror = (e) => {
                console.error(`Error reading TTML file: ${e}`);
            };
            reader.readAsText(file);
        }
    }).catch(() => {
        console.log('No TTML file found');
    });
}

function updateSyncedLyrics() {
    if (!currentLyrics || currentLyrics.length === 0 || !wavesurfer) return;
    
    const currentTime = wavesurfer.getCurrentTime();
    
    // Find all lyrics that should be displayed (not just the current one)
    const displayedLyrics = [];
    for (const lyric of currentLyrics) {
        if (currentTime >= lyric.begin && currentTime < lyric.end) {
            displayedLyrics.push(lyric);
        }
    }
    
    const lyricsBox = document.getElementById('synced-lyrics');
    const lyricsContainer = document.getElementById('current-lyric');
    
    if (displayedLyrics.length === 0) {
        lyricsContainer.innerHTML = '';
        return;
    }
    
    let html = '';
    
    // Track which agents we've shown names for on this screen
    const agentsShownThisFrame = new Set();
    
    // Render each displayed lyric line
    displayedLyrics.forEach((currentLyric, lineIndex) => {
        const highlightColor = getAgentColor(currentLyric.agent);
        
        // Add line with appropriate styling
        if (lineIndex > 0) {
            html += '<br/>';
        }
        
        // Add agent name above the line if this is the first line from that agent on screen
        if (!agentsShownThisFrame.has(currentLyric.agent) && currentLyric.agentName) {
            html += `<span style="display: block; font-size: 0.75em; font-weight: 300; opacity: 0.7; margin-bottom: 4px; color: ${highlightColor};">${currentLyric.agentName}</span>`;
            agentsShownThisFrame.add(currentLyric.agent);
        }
        
        // Render main line
        for (let i = 0; i < currentLyric.mainSpans.length; i++) {
            const spanData = currentLyric.mainSpans[i];
            let style = '';
            
            if (currentTime >= spanData.begin && currentTime < spanData.end) {
                // Currently singing
                const timeInSpan = currentTime - spanData.begin;
                const spanDuration = spanData.end - spanData.begin;
                const progress = Math.max(0, Math.min(1, timeInSpan / spanDuration));
                const gradientPercent = (progress * 100).toFixed(2);
                style = `background: linear-gradient(90deg, ${highlightColor} 0%, ${highlightColor} ${gradientPercent}%, #333 ${gradientPercent}%, #333 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;`;
            } else if (currentTime >= spanData.end) {
                // Already sung
                style = `color: ${highlightColor};`;
            } else {
                // Upcoming
                style = 'color: #333;';
            }
            
            html += `<span style="${style}">${spanData.text}</span>`;
            
            // Add space after span (preserve spacing from TTML)
            if (spanData.hasTrailingSpace) {
                html += ' ';
            }
        }
        
        // Render background spans (ad-libs) as a separate, smaller line below
        if (currentLyric.bgSpans.length > 0) {
            html += '<br/><span style="display: block; font-size: 0.75em; opacity: 0.85; margin-top: 6px;">';
            
            for (let i = 0; i < currentLyric.bgSpans.length; i++) {
                const spanData = currentLyric.bgSpans[i];
                let style = '';
                
                if (currentTime >= spanData.begin && currentTime < spanData.end) {
                    // Currently singing
                    const timeInSpan = currentTime - spanData.begin;
                    const spanDuration = spanData.end - spanData.begin;
                    const progress = Math.max(0, Math.min(1, timeInSpan / spanDuration));
                    const gradientPercent = (progress * 100).toFixed(2);
                    style = `background: linear-gradient(90deg, ${highlightColor} 0%, ${highlightColor} ${gradientPercent}%, #333 ${gradientPercent}%, #333 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;`;
                } else if (currentTime >= spanData.end) {
                    // Already sung
                    style = `color: ${highlightColor};`;
                } else {
                    // Upcoming
                    style = 'color: #333;';
                }
                
                html += `<span style="${style}">${spanData.text}</span>`;
                
                // Add space between background spans
                if (spanData.hasTrailingSpace) {
                    html += ' ';
                }
            }
            
            html += '</span>';
        }
    });
    
    lyricsContainer.innerHTML = html;
}

function getFile(key) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['files'], 'readonly');
        const store = transaction.objectStore('files');
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function loadFilesForAlbums() {
    const promises = [];
    albums.forEach(album => {
        album.tracks.forEach(track => {
            if (track.fileKey) {
                promises.push(getFile(track.fileKey).then(file => {
                    track.file = file;
                }).catch(() => {
                    // File not found, perhaps deleted
                }));
            }
            if (track.ttmlKey) {
                promises.push(getFile(track.ttmlKey).then(file => {
                    track.ttmlFile = file;
                }).catch(() => {
                    // TTML file not found
                }));
            }
        });
    });
    Promise.all(promises).then(() => {
        renderAlbums();
    });
}


function saveToStorage() {
    // Save all albums to IndexedDB
    if (albumsDb) {
        albums.forEach(album => {
            // Remove file/ttmlFile from tracks before saving
            const cleanAlbum = {
                ...album,
                tracks: album.tracks.map(track => ({
                    ...track,
                    file: undefined,
                    ttmlFile: undefined
                }))
            };
            saveAlbumToDb(cleanAlbum);
        });
    }
    localStorage.setItem('settings', JSON.stringify(settings));
}

function renderAlbums() {
    const container = document.getElementById('albums-container');
    container.innerHTML = '';
    document.getElementById("no-album-msg").classList.toggle('hidden', albums.length > 0);
    albums.forEach(album => {
        const totalDuration = album.tracks
            .filter(t => t.file && t.duration)
            .reduce((sum, t) => sum + t.duration, 0);
        
        const durationStr = totalDuration > 0 ? ` (${formatTime(totalDuration)})` : '';
        
        const card = document.createElement('div');
        card.className = 'album-card';
        card.innerHTML = `
            <img src="${album.cover || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZGRkIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtc2l6ZT0iMTgiIGZpbGw9IiM5OTkiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5ObyBDb3ZlcjwvdGV4dD48L3N2Zz4='}" alt="Cover">
            <h3>${album.title}</h3>
            <p>${album.tracks.length} tracks${durationStr}</p>
            <button class="delete-album-btn hidden">Delete</button>
        `;
        card.addEventListener('click', (e) => {
            if (!e.target.classList.contains('delete-album-btn')) {
                openAlbum(album);
            }
        });
        card.querySelector('.delete-album-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Delete this album?')) {
                albums = albums.filter(a => a.id !== album.id);
                renderAlbums();
                saveToStorage();
            }
        });
        container.appendChild(card);
    });
}

function openAlbum(album) {
    currentAlbum = album;
    const titleElement = document.getElementById('modal-album-title');
    titleElement.textContent = album.title;
    titleElement.addEventListener('dblclick', () => editAlbumTitle(titleElement));
    document.getElementById('modal-cover-img').src = album.cover || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZGRkIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtc2l6ZT0iMTgiIGZpbGw9IiM5OTkiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj5ObyBDb3ZlcjwvdGV4dD48L3N2Zz4=';
    renderModalTracks();
    document.getElementById('album-modal').classList.remove('hidden');
    document.getElementById('album-modal').classList.add('show');
}

function editAlbumTitle(titleElement) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = titleElement.textContent;
    input.style.fontSize = '24px';
    input.style.fontWeight = 'bold';
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.background = 'transparent';
    input.style.width = '100%';
    titleElement.replaceWith(input);
    input.focus();
    input.select();

    const saveTitle = () => {
        const newTitle = input.value.trim();
        if (newTitle) {
            currentAlbum.title = newTitle;
            titleElement.textContent = newTitle;
            input.replaceWith(titleElement);
            saveToStorage();
            renderAlbums(); // Update the album card
        } else {
            input.replaceWith(titleElement);
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            saveTitle();
        } else if (e.key === 'Escape') {
            input.replaceWith(titleElement);
        }
    });

    input.addEventListener('blur', saveTitle);
}

function renderModalTracks() {
    const container = document.getElementById('modal-tracks-container');
    container.innerHTML = '';
    
    const allMissing = currentAlbum.tracks.every(t => !t.file);
    const massImportBtn = document.getElementById('mass-import-btn');
    if (allMissing && currentAlbum.tracks.length >= 2) {
        massImportBtn.classList.remove('hidden');
    } else {
        massImportBtn.classList.add('hidden');
    }
    
    currentAlbum.tracks.forEach((track, index) => {
        const missing = !track.file;
        const item = document.createElement('div');
        item.className = `track-item${missing ? ' missing-track' : ''}`;
        item.draggable = !missing;
        item.title = missing ? 'Audio file missing. Restore the file to play or download this track.' : '';
        const durationStr = track.duration ? formatTime(track.duration) : 'N/A';
        item.innerHTML = `
            <span class="track-number">${index + 1}.</span>
            <div class="track-details">
                <div class="track-name">${track.name}${track.explicit ? ' <span class="explicit-badge">Explicit</span>' : ''}</div>
                <div class="track-meta">${durationStr === "N/A" ? "" : durationStr + " | "}Producers: ${track.producers || 'N/A'} | Writers: ${track.writers || 'N/A'}</div>
                ${track.tags ? `<div class="track-tags">${track.tags.map(tag => `<span class="tag ${tag.toLowerCase().replace(/\s+/g, '-')}">${tag}</span>`).join('')}</div>` : ''}
            </div>
            <div class="track-actions">
                ${missing ? '' : '<button class="play-btn">Play</button>'}
                <button class="edit-btn">Edit</button>
                ${missing ? '<button class="restore-btn">Restore File</button>' : '<button class="download-btn">Download</button>'}
                <button class="delete-btn">Delete</button>
            </div>
        `;
        item.addEventListener('dragstart', (e) => {
            if (!missing) {
                e.dataTransfer.setData('text/plain', index);
                item.classList.add('dragging');
            }
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
        });
        if (!missing) {
            item.querySelector('.play-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                playTrack(index);
            });
        }
        item.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            editTrack(index);
        });
        if (!missing) {
            item.querySelector('.download-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                downloadTrack(track);
            });
        }
        item.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteTrack(index);
        });
        if (missing) {
            item.querySelector('.restore-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                restoreTrackFile(index);
            });
        }
        container.appendChild(item);
    });
    container.addEventListener('dragover', (e) => e.preventDefault());
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
        const toIndex = Array.from(container.children).indexOf(e.target.closest('.track-item'));
        if (fromIndex !== toIndex && toIndex !== -1) {
            const [moved] = currentAlbum.tracks.splice(fromIndex, 1);
            currentAlbum.tracks.splice(toIndex, 0, moved);
            renderModalTracks();
            saveToStorage();
        }
    });
};

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr) {
    const parts = timeStr.split(':');
    if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return 0; // fallback
}

async function stripTTMLBackgroundSpans(file) {
    const text = await file.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, 'text/xml');
    if (xmlDoc.getElementsByTagName('parsererror').length) {
        return file;
    }
    const spans = Array.from(xmlDoc.getElementsByTagName('span'));
    spans.forEach(span => {
        if (span.getAttribute('ttm:role') === 'x-bg') {
            span.remove();
        }
    });
    const cleaned = new XMLSerializer().serializeToString(xmlDoc);
    return new File([cleaned], file.name, { type: file.type || 'application/xml' });
}

function playTrack(index) {
    currentTrackIndex = index;
    const track = currentAlbum.tracks[index];
    if (track.file) {
        if (wavesurfer) wavesurfer.destroy();
        wavesurfer = WaveSurfer.create({
            container: '#waveform',
            waveColor: '#4F4A85',
            progressColor: '#383351',
            height: 80,
            responsive: true,
            scrollParent: true
        });
        const url = URL.createObjectURL(track.file);
        loadStartTime = Date.now();
        wavesurfer.load(url);
        wavesurfer.on('ready', () => {
            loadDuration = Date.now() - loadStartTime;
            console.log(`Track loaded in ${loadDuration}ms`);
            wavesurfer.play();

            const duration = wavesurfer.getDuration();
            track.duration = duration;
            
            const volumeValue = document.getElementById('volume-slider').value;
            wavesurfer.setVolume(volumeValue / 100);
            
            document.getElementById('current-track-info').innerHTML = `${track.name} &bull; <em>${currentAlbum.title}</em><br>Producers: ${track.producers || 'N/A'}<br>Writers: ${track.writers || 'N/A'}`;
            document.getElementById('duration-time').textContent = formatTime(wavesurfer.getDuration());
            document.getElementById('audio-player').classList.remove('hidden');
            
            document.getElementById('play-pause-btn').textContent = 'Pause';
            
            // Load TTML if niche mode is enabled
            if (settings.nicheMode && track.ttmlKey) {
                loadTTML(track.ttmlKey);
            }
            
            // Update time display
            wavesurfer.on('audioprocess', (currentTime) => {
                document.getElementById('current-time').textContent = formatTime(currentTime);
                
                if (currentLyrics) {
                    updateSyncedLyrics();
                }
            });
            
            preloadNext();
        });
        wavesurfer.on('finish', () => {
            nextTrack();
        });
    }
}

function preloadNext() {
    const nextIndex = getNextIndex();
    if (nextIndex !== -1) {
        const nextTrack = currentAlbum.tracks[nextIndex];
        if (nextTrack.file) {
            setTimeout(() => {
                if (preloadWavesurfer) preloadWavesurfer.destroy();
                preloadWavesurfer = WaveSurfer.create({
                    container: document.createElement('div'),
                    height: 1
                });
                const url = URL.createObjectURL(nextTrack.file);
                preloadWavesurfer.load(url);
            }, loadDuration + 5000);
        }
    }
}

function getNextIndex() {
    if (repeatMode === 'track') return currentTrackIndex;
    if (repeatMode === 'album') {
        return (currentTrackIndex + 1) % currentAlbum.tracks.length;
    }
    if (isShuffled) {
        // For simplicity, just next in shuffled order, but since we don't have shuffled list, just next
        return (currentTrackIndex + 1) % currentAlbum.tracks.length;
    }
    const next = currentTrackIndex + 1;
    return next < currentAlbum.tracks.length ? next : -1;
}

function nextTrack() {
    const next = getNextIndex();
    if (next !== -1) {
        playTrack(next);
    } else {
        closePlayer();
    }
}

function prevTrack() {
    let prev = currentTrackIndex - 1;
    if (prev < 0) {
        if (repeatMode === 'album') prev = currentAlbum.tracks.length - 1;
        else prev = 0;
    }
    playTrack(prev);
}

function closePlayer() {
    if (wavesurfer) wavesurfer.stop();
    document.getElementById('audio-player').classList.add('hidden');
    document.getElementById('synced-lyrics').classList.add('hidden');
    currentLyrics = null;
}

function editTrack(index) {
    const track = currentAlbum.tracks[index];
    document.getElementById('track-name').value = track.name;
    document.getElementById('track-producers').value = track.producers || settings.defaultProducers;
    document.getElementById('track-writers').value = track.writers || settings.defaultWriters;
    document.getElementById('track-notes').value = track.notes || '';
    document.getElementById('track-explicit').checked = !!track.explicit;
    
    // Show/hide niche mode fields
    const nichtModeFields = document.getElementById('niche-mode-fields');
    if (settings.nicheMode) {
        nichtModeFields.classList.remove('hidden');
    } else {
        nichtModeFields.classList.add('hidden');
    }

    const fileNameEl = document.getElementById('current-file-name');
    if (track.file) {
        fileNameEl.textContent = `Current: ${track.originalName || 'Audio file'}`;
    } else {
        fileNameEl.textContent = 'No audio file';
    }
    
    renderTagOptions(track.tags || []);

    const fileInput = document.getElementById('track-file-upload');
    const uploadBtn = document.getElementById('track-file-upload-btn');
    
    uploadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        fileInput.click();
    });
    
    fileInput.addEventListener('change', (e) => {
        const newFile = e.target.files[0];
        if (newFile) {
            if (!newFile.type.startsWith('audio/')) {
                alert('Please select a valid audio file');
                return;
            }
            
            if (track.fileKey) {
                const tx = db.transaction(['files'], 'readwrite');
                const store = tx.objectStore('files');
                store.delete(track.fileKey);
            }
            
            track.file = newFile;
            track.originalName = newFile.name;
            track.fileKey = track.fileKey || `${currentAlbum.id}-${track.id}`;
            
            storeFile(track.fileKey, newFile);
            
            const tempWs = WaveSurfer.create({
                container: document.createElement('div'),
                height: 1
            });
            const url = URL.createObjectURL(newFile);
            tempWs.load(url);
            tempWs.on('ready', () => {
                track.duration = tempWs.getDuration();
                tempWs.destroy();
                saveToStorage();
                fileNameEl.textContent = `Current: ${newFile.name}`;
            });
            
            fileInput.value = '';
        }
    });
    
    document.getElementById('track-modal').classList.remove('hidden');
    document.getElementById('track-modal').classList.add('show');
    document.getElementById('track-form').onsubmit = async (e) => {
        e.preventDefault();
        track.name = document.getElementById('track-name').value;
        track.producers = document.getElementById('track-producers').value;
        track.writers = document.getElementById('track-writers').value;
        track.notes = document.getElementById('track-notes').value;
        track.explicit = document.getElementById('track-explicit').checked;
        track.tags = Array.from(document.querySelectorAll('#tag-options input:checked')).map(cb => cb.value);
        
        // Handle TTML file upload if niche mode is enabled
        const ttmlInput = document.getElementById('track-ttml');
        if (settings.nicheMode && ttmlInput.files.length > 0) {
            const ttmlFile = ttmlInput.files[0];
            track.ttmlFile = ttmlFile;
            track.ttmlKey = track.ttmlKey || `${currentAlbum.id}-${track.id}-ttml`;
            storeFile(track.ttmlKey, ttmlFile);
        }
        
        renderModalTracks();
        saveToStorage();
        closeModal('track-modal');
    };
}

function renderTagOptions(selectedTags) {
    const container = document.getElementById('tag-options');
    const defaultTags = [
        'Final Master', 'Final Mix', 'Clearance Required', 'Mastering Required', 'Mixing Required',
        'Demo Version', 'Unfinished', 'Reference Track', 'Instrumental', 'Vocals Only',
        'Performance Track', 'Open Verse',
        'Radio Edit'
    ];
    const allTags = [...defaultTags, ...settings.customTags];
    container.innerHTML = '';
    allTags.forEach(tag => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = tag;
        input.checked = selectedTags.includes(tag);
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + tag));
        container.appendChild(label);
    });
}

function deleteTrack(index) {
    const track = currentAlbum.tracks[index];
    if (confirm('Delete this track?')) {
        if (track.fileKey) {
            const transaction = db.transaction(['files'], 'readwrite');
            const store = transaction.objectStore('files');
            store.delete(track.fileKey);
        }
        currentAlbum.tracks.splice(index, 1);
        renderModalTracks();
        saveToStorage();
    }
}

function downloadTrack(track) {
    if (!track.file) return;
    const url = URL.createObjectURL(track.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = track.originalName || `${track.name}.mp3`;
    a.click();
}

function restoreTrackFile(index) {
    const track = currentAlbum.tracks[index];
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            track.file = file;
            track.originalName = track.originalName || file.name;
            track.fileKey = track.fileKey || `${currentAlbum.id}-${track.id}`;
            storeFile(track.fileKey, file);
            renderModalTracks();
            saveToStorage();
        }
    });
    input.click();
}


function deleteAlbum() {
    if (confirm('Delete this album?')) {
        currentAlbum.tracks.forEach(track => {
            if (track.fileKey) {
                const transaction = db.transaction(['files'], 'readwrite');
                const store = transaction.objectStore('files');
                store.delete(track.fileKey);
            }
        });
        const albumId = currentAlbum.id;
        albums = albums.filter(a => a.id !== albumId);
        deleteAlbumFromDb(albumId).then(() => {
            renderAlbums();
            saveToStorage();
            closeModal('album-modal');
        });
    }
}

function renderCustomTags() {
    const list = document.getElementById('custom-tags-list');
    list.innerHTML = '';
    settings.customTags.forEach((tag, index) => {
        const div = document.createElement('div');
        div.innerHTML = `${tag} <button type="button" onclick="removeCustomTag(${index})">Remove</button>`;
        list.appendChild(div);
    });
}

function removeCustomTag(index) {
    settings.customTags.splice(index, 1);
    renderCustomTags();
    saveToStorage();
}

document.getElementById('add-custom-tag-btn').addEventListener('click', () => {
    const newTag = document.getElementById('new-custom-tag').value.trim();
    if (newTag && !settings.customTags.includes(newTag)) {
        settings.customTags.push(newTag);
        document.getElementById('new-custom-tag').value = '';
        renderCustomTags();
        saveToStorage();
    }
});

document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    settings.defaultProducers = document.getElementById('default-producers').value;
    settings.defaultWriters = document.getElementById('default-writers').value;
    settings.nicheMode = document.getElementById('niche-mode-checkbox').checked;
    saveToStorage();
    closeModal('settings-modal');
});

document.getElementById('modal-cover-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = () => {
            currentAlbum.cover = reader.result;
            document.getElementById('modal-cover-img').src = reader.result;
            saveToStorage();
        };
        reader.readAsDataURL(file);
    }
});

document.getElementById('modal-add-track-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.multiple = true;
    let filesSelected = false;
    input.addEventListener('change', (e) => {
        filesSelected = true;
        if (e.target.files.length > 0) {
            Array.from(e.target.files).forEach(file => {
                const track = {
                    id: Date.now().toString() + Math.random(),
                    file,
                    name: file.name.replace(/\.[^/.]+$/, ''),
                    producers: settings.defaultProducers,
                    writers: settings.defaultWriters,
                    notes: '',
                    explicit: false,
                    tags: [],
                    originalName: file.name,
                    fileKey: `${currentAlbum.id}-${Date.now().toString() + Math.random()}`
                };
                storeFile(track.fileKey, file);
                currentAlbum.tracks.push(track);
            });
            renderModalTracks();
            saveToStorage();
        } else {
            promptForTrackName();
        }
    });
    input.addEventListener('cancel', () => {
        if (!filesSelected) {
            promptForTrackName();
        }
    });
    input.click();
});

function promptForTrackName() {
    const trackName = prompt('Enter track name:');
    if (trackName) {
        const track = {
            id: Date.now().toString() + Math.random(),
            name: trackName,
            producers: settings.defaultProducers,
            writers: settings.defaultWriters,
            notes: '',
            explicit: false,
            tags: [],
            originalName: null
        };
        currentAlbum.tracks.push(track);
        renderModalTracks();
        saveToStorage();
    }
}

document.getElementById('modal-download-album-btn').addEventListener('click', () => {
    const zip = new JSZip();
    const folder = zip.folder(currentAlbum.title);
    currentAlbum.tracks.forEach((track, index) => {
        if (track.file) {
            folder.file(`${index + 1}. ${track.originalName}`, track.file);
        }
    });
    if (currentAlbum.cover) {
        const coverData = currentAlbum.cover.split(',')[1];
        folder.file('cover.jpg', coverData, { base64: true });
    }
    zip.generateAsync({ type: 'blob' }).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentAlbum.title}.zip`;
        a.click();
    });
});

document.getElementById('modal-delete-album-btn').addEventListener('click', deleteAlbum);

// Modal close
document.querySelectorAll('.close').forEach(close => {
    close.addEventListener('click', () => {
        const modal = close.closest('.modal');
        closeModal(modal.id);
    });
});

window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        closeModal(e.target.id);
    }
});

function closeModal(id) {
    const modal = document.getElementById(id);
    modal.classList.remove('show');
    modal.classList.add('hidden');
    setTimeout(() => modal.classList.remove('hidden'), 300);
    if (id === 'album-modal') {
        renderAlbums(); // Update album cards
    }
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
    const menu = document.getElementById('menu');
    const hamburger = document.getElementById('hamburger-btn');
    if (!menu.contains(e.target) && !hamburger.contains(e.target) && !menu.classList.contains('hidden')) {
        closeMenu();
    }
});

document.getElementById('close-player-btn').addEventListener('click', closePlayer);

document.getElementById('minimize-player-btn').addEventListener('click', () => {
    document.getElementById('audio-player').classList.toggle('minimized');
});

document.getElementById('volume-slider').addEventListener('input', (e) => {
    const volume = e.target.value / 100;
    if (wavesurfer) {
        wavesurfer.setVolume(volume);
    }
});

document.getElementById('play-pause-btn').addEventListener('click', () => {
    if (wavesurfer) {
        wavesurfer.playPause();
        document.getElementById('play-pause-btn').textContent = wavesurfer.isPlaying() ? 'Pause' : 'Play';
    }
});

document.getElementById('prev-btn').addEventListener('click', prevTrack);

document.getElementById('next-btn').addEventListener('click', nextTrack);

/*document.getElementById('shuffle-btn').addEventListener('click', () => {
    isShuffled = !isShuffled;
    document.getElementById('shuffle-btn').classList.toggle('active', isShuffled);
});

document.getElementById('repeat-btn').addEventListener('click', () => {
    if (repeatMode === 'none') repeatMode = 'track';
    else if (repeatMode === 'track') repeatMode = 'album';
    else repeatMode = 'none';
    document.getElementById('repeat-btn').textContent = `Repeat${repeatMode === "none" ? "" : ` ${repeatMode}`}`;
    document.getElementById('repeat-btn').classList.toggle('active', repeatMode !== 'none');
});*/

document.getElementById('new-album-btn').addEventListener('click', () => {
    const album = { id: Date.now().toString(), title: 'New Album', cover: '', tracks: [] };
    albums.push(album);
    saveAlbumToDb(album).then(() => {
        renderAlbums();
        saveToStorage();
        closeMenu();
    });
});

document.getElementById('help-btn').addEventListener('click', () => {
    closeMenu();
    document.getElementById('help-modal').classList.remove('hidden');
    document.getElementById('help-modal').classList.add('show');
});

document.getElementById('mass-import-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            await importAudioFromZip(file);
        }
    });
    input.click();
});

async function importAudioFromZip(zipFile) {
    try {
        const zip = new JSZip();
        const loadedZip = await zip.loadAsync(zipFile);
        
        const fileMap = {};
        for (const [path, zipEntry] of Object.entries(loadedZip.files)) {
            if (!zipEntry.dir && !path.includes('cover')) {
                const fileName = path.split('/').pop();
                fileMap[fileName] = zipEntry;
            }
        }
        
        let importedCount = 0;
        for (let i = 0; i < currentAlbum.tracks.length; i++) {
            const track = currentAlbum.tracks[i];
            if (!track.file) {
                const expectedFileName = `${i + 1}. ${track.originalName}`;
                if (fileMap[expectedFileName]) {
                    const blob = await fileMap[expectedFileName].async('blob');
                    const audioFile = new File([blob], expectedFileName, { type: 'audio/mpeg' });
                    track.file = audioFile;
                    track.fileKey = track.fileKey || `${currentAlbum.id}-${track.id}`;
                    storeFile(track.fileKey, audioFile);
                    importedCount++;
                }
            }
        }
        
        renderModalTracks();
        saveToStorage();
        alert(`Successfully imported ${importedCount} audio file(s).`);
    } catch (error) {
        console.error('Error importing from ZIP:', error);
        alert('Error reading ZIP file. Please ensure it\'s a valid ZIP export.');
    }
}

document.getElementById('hamburger-btn').addEventListener('click', () => {
    const menu = document.getElementById('menu');
    menu.classList.toggle('hidden');
    menu.classList.toggle('open');
});

document.querySelector('.close-menu').addEventListener('click', closeMenu);

function closeMenu() {
    const menu = document.getElementById('menu');
    menu.classList.add('hidden');
    menu.classList.remove('open');
}

document.getElementById('settings-btn').addEventListener('click', () => {
    closeMenu();
    document.getElementById('default-producers').value = settings.defaultProducers;
    document.getElementById('default-writers').value = settings.defaultWriters;
    document.getElementById('niche-mode-checkbox').checked = settings.nicheMode || false;
    renderCustomTags();
    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('settings-modal').classList.add('show');
});

document.getElementById('import-btn').addEventListener('click', () => {
    closeMenu();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = () => {
                const data = JSON.parse(reader.result);
                albums = data.albums.map(album => ({
                    ...album,
                    tracks: album.tracks.map(track => {
                        let fileObj = null;
                        if (track.file) {
                            fileObj = new File([Uint8Array.from(atob(track.file), c => c.charCodeAt(0))], track.originalName);
                            track.fileKey = track.fileKey || `${album.id}-${track.id}`;
                            storeFile(track.fileKey, fileObj);
                        }
                        return {
                            ...track,
                            file: fileObj,
                            notes: track.notes || '',
                            tags: track.tags || []
                        };
                    })
                }));
                renderAlbums();
                saveToStorage();
            };
            reader.readAsText(file);
        }
    });
    input.click();
});

document.getElementById('export-btn').addEventListener('click', () => {
    closeMenu();
    const data = {
        albums: albums.map(album => ({
            ...album,
            tracks: album.tracks.map(track => ({
                ...track,
                file: track.file ? btoa(String.fromCharCode(...new Uint8Array(track.file))) : null
            }))
        }))
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'albums.json';
    a.click();
});

renderAlbums();
