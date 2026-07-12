document.addEventListener('DOMContentLoaded', () => {
  // --- UAT Access Code (Armor) ---
  let apiKey = localStorage.getItem('apss_api_key');
  if (!apiKey) {
    apiKey = prompt("Enter UAT Access Code to access APSS Integration Hub:");
    if (apiKey) {
      localStorage.setItem('apss_api_key', apiKey);
    }
  }

  // Intercept all fetch requests to inject the API key and handle 401
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    let [resource, config] = args;
    if (typeof resource === 'string' && resource.startsWith('/api/') && resource !== '/api/heartbeat') {
      config = config || {};
      config.headers = {
        ...config.headers,
        'x-api-key': localStorage.getItem('apss_api_key') || ''
      };
    }
    const response = await originalFetch(resource, config);
    if (response.status === 401) {
      localStorage.removeItem('apss_api_key');
      alert("Unauthorized: Invalid UAT Access Code. Please refresh the page.");
    }
    return response;
  };

  // --- UAT Online Users Heartbeat ---
  let deviceId = localStorage.getItem('apss_device_id');
  if (!deviceId) {
    deviceId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    localStorage.setItem('apss_device_id', deviceId);
  }

  function sendHeartbeat() {
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId })
    })
    .then(res => res.json())
    .then(data => {
      const counterLabel = document.getElementById('online-users-counter');
      if (counterLabel && data.activeUsers !== undefined) {
        if (data.activeUsers > 1) {
          counterLabel.innerHTML = `Online: <b style="color:#ef4444">${data.activeUsers} users</b> (Conflict risk!)`;
        } else {
          counterLabel.innerHTML = `Online: ${data.activeUsers} user`;
        }
      }
    }).catch(e => console.error("Heartbeat error", e));
  }
  
  sendHeartbeat();
  setInterval(sendHeartbeat, 5000); // 5 seconds
  // ----------------------------------

  const logo = document.querySelector('.apss-logo-img');
  if (logo) {
    const blendLogo = () => {
      const canvas = document.createElement('canvas');
      canvas.width = logo.naturalWidth;
      canvas.height = logo.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(logo, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);

        if (r > 198 && g > 198 && b > 198 && max - min < 28) {
          data[i + 3] = 0;
          continue;
        }

        if (max - min < 45 && max < 170) {
          data[i] = Math.min(255, Math.round(r * 1.55 + 45));
          data[i + 1] = Math.min(255, Math.round(g * 1.55 + 45));
          data[i + 2] = Math.min(255, Math.round(b * 1.55 + 45));
        }
      }

      ctx.putImageData(imgData, 0, 0);
      logo.src = canvas.toDataURL('image/png');
      logo.classList.add('logo-ready');
    };

    if (logo.complete && logo.naturalWidth) {
      blendLogo();
    } else {
      logo.addEventListener('load', blendLogo, { once: true });
    }
  }

  const menuItems = document.querySelectorAll('.menu-item');
  const sections = document.querySelectorAll('.workspace-section');

  menuItems.forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('disabled')) return;

      menuItems.forEach(menuItem => menuItem.classList.remove('active'));
      item.classList.add('active');

      const target = item.getAttribute('data-target');
      sections.forEach(section => {
        section.classList.toggle('active', section.id === target);
      });
    });
  });

  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const formatDateTime = value => {
    if (!value) return 'None';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const pttep = {
    dropzone: document.getElementById('pttep-dropzone'),
    fileInput: document.getElementById('pttep-file-input'),
    uploadBtn: document.getElementById('pttep-upload-btn'),
    refreshBtn: document.getElementById('refresh-pttep-status-btn'),
    clearBtn: document.getElementById('clear-pttep-feed-btn'),
    loading: document.getElementById('pttep-loading-spinner'),
    loadingText: document.getElementById('pttep-loading-text'),
    progressFill: document.getElementById('pttep-progress-fill'),
    progressStage: document.getElementById('pttep-progress-stage'),
    progressPercent: document.getElementById('pttep-progress-percent'),
    statItems: document.getElementById('pttep-stat-items'),
    statPrs: document.getElementById('pttep-stat-prs'),
    tbody: document.getElementById('pttep-pr-tbody'),
    runStatus: document.getElementById('pttep-run-status')
  };

  let pttepPollTimer = null;

  function renderPttepImportProgress(importState) {
    const percent = Math.max(0, Math.min(100, Number(importState?.percent || 0)));
    const stage = importState?.stage || 'Preparing import...';
    const detail = importState?.detail || '';

    if (pttep.progressFill) pttep.progressFill.style.width = `${percent}%`;
    if (pttep.progressPercent) pttep.progressPercent.textContent = `${percent}%`;
    if (pttep.progressStage) pttep.progressStage.textContent = stage;

    if (pttep.loadingText) {
      pttep.loadingText.textContent = detail || stage;
    }
  }

  async function loadPttepStatus() {
    const response = await fetch('/api/pttep/catalog/status');
    if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    const payload = await response.json();
    if (!payload.success) throw new Error(payload.error || 'Status request failed');
    renderPttepStatus(payload);
  }

  async function loadPttepImportStatus() {
    const response = await fetch('/api/pttep/import/status');
    if (!response.ok) throw new Error(`Import status request failed (${response.status})`);
    const payload = await response.json();
    if (!payload.success) throw new Error(payload.error || 'Import status request failed');
    return payload.import || null;
  }

  function renderPttepStatus(payload) {
    const catalog = payload.catalog || {};
    pttep.statItems.textContent = catalog.item_count || 0;
    pttep.statPrs.textContent = catalog.group_count || 0;
    if (pttep.runStatus) {
      pttep.runStatus.textContent = catalog.exists
        ? `Last refreshed ${formatDateTime(catalog.scraped_at)}`
        : 'No PTTEP Excel feed has been imported yet.';
    }

    const rows = catalog.brand_groups || [];
    if (!rows.length) {
      pttep.tbody.innerHTML = `
        <tr>
          <td colspan="6" class="empty-cell">No PTTEP feed found yet. Import the latest FlashBuy Excel file to create the middleware feed.</td>
        </tr>
      `;
      return;
    }

    pttep.tbody.innerHTML = rows.slice(0, 80).map(row => `
      <tr>
        <td class="mono-cell">${escapeHtml(row.group_key)}</td>
        <td class="left-cell">${escapeHtml(row.brand_name || 'UNSPECIFIED BRAND')}</td>
        <td>${escapeHtml(row.item_count || 0)}</td>
        <td>${escapeHtml(row.total_quantity || 0)}</td>
        <td class="left-cell">${escapeHtml(row.sample_description || 'No description')}</td>
        <td>${escapeHtml(row.close_date || '-')}</td>
      </tr>
    `).join('');
  }

  function setPttepBusy(isBusy) {
    if (pttep.uploadBtn) pttep.uploadBtn.disabled = isBusy;
    if (pttep.refreshBtn) pttep.refreshBtn.disabled = isBusy;
    if (pttep.clearBtn) pttep.clearBtn.disabled = isBusy;
    if (pttep.fileInput) pttep.fileInput.disabled = isBusy;
    if (pttep.dropzone) pttep.dropzone.classList.toggle('disabled', isBusy);
  }

  async function runPttepImport(file) {
    if (!file) return;
    pttep.loading.classList.remove('hidden');
    setPttepBusy(true);
    renderPttepImportProgress({
      percent: 1,
      stage: 'Uploading Excel file',
      detail: `Uploading ${file.name}...`
    });
    if (pttep.runStatus) {
      pttep.runStatus.textContent = `Importing ${file.name}. The feed will refresh automatically when processing finishes.`;
    }

    window.clearInterval(pttepPollTimer);
    pttepPollTimer = window.setInterval(() => {
      loadPttepImportStatus()
        .then(importState => {
          if (importState) renderPttepImportProgress(importState);
        })
        .catch(() => {});
    }, 1000);

    try {
      const response = await fetch('/api/upload?live=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        },
        body: file
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Import failed (${response.status})`);
      }

      const payload = await response.json();
      if (payload.error) throw new Error(payload.error);
      
      // Wait for background process to complete if it returns 202
      if (response.status === 202 || payload.status_url) {
        await new Promise((resolve) => {
          const waitTimer = setInterval(async () => {
            const state = await loadPttepImportStatus().catch(() => null);
            if (state && !state.running && state.completedAt) {
              clearInterval(waitTimer);
              resolve();
            }
          }, 1500);
        });
      }

      const finalState = await loadPttepImportStatus().catch(() => null);
      if (finalState && finalState.error) {
        throw new Error(finalState.error);
      }
      
      await loadPttepStatus();
      if (pttep.runStatus) {
        const itemCount = finalState?.summary?.total ?? pttep.statItems.textContent;
        const groupCount = finalState?.summary?.brand_count ?? pttep.statPrs.textContent;
        pttep.runStatus.textContent = `Import completed. Feed has ${itemCount} items grouped into ${groupCount} brand records for BC.`;
      }
    } catch (err) {
      const importState = await loadPttepImportStatus().catch(() => null);
      if (importState) renderPttepImportProgress(importState);
      await loadPttepStatus().catch(() => {});
      alert(`PTTEP import error: ${err.message}`);
    } finally {
      window.clearInterval(pttepPollTimer);
      pttepPollTimer = null;
      window.setTimeout(() => {
        pttep.loading.classList.add('hidden');
      }, 700);
      setPttepBusy(false);
      if (pttep.fileInput) pttep.fileInput.value = '';
    }
  }

  async function clearLatestPttepFeed() {
    const confirmed = window.confirm('Clear the latest PTTEP feed snapshot? This only removes the most recent PTTEP Excel import so you can run a fresh import.');
    if (!confirmed) return;

    setPttepBusy(true);

    try {
      const response = await fetch('/api/pttep/catalog/latest', { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || `Clear failed (${response.status})`);
      }

      await loadPttepStatus();
      if (pttep.runStatus) {
        pttep.runStatus.textContent = payload.deleted
          ? 'Latest PTTEP feed cleared. Import a new Excel file to create a fresh feed.'
          : 'No PTTEP feed snapshot was available to clear.';
      }
    } catch (err) {
      alert(`Clear feed error: ${err.message}`);
    } finally {
      setPttepBusy(false);
    }
  }

  pttep.uploadBtn?.addEventListener('click', () => pttep.fileInput?.click());
  pttep.fileInput?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) runPttepImport(file);
  });
  pttep.dropzone?.addEventListener('dragover', event => {
    event.preventDefault();
    pttep.dropzone.classList.add('dragover');
  });
  pttep.dropzone?.addEventListener('dragleave', () => {
    pttep.dropzone.classList.remove('dragover');
  });
  pttep.dropzone?.addEventListener('drop', event => {
    event.preventDefault();
    pttep.dropzone.classList.remove('dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) runPttepImport(file);
  });
  pttep.refreshBtn?.addEventListener('click', () => {
    loadPttepStatus().catch(err => alert(`Status error: ${err.message}`));
  });
  pttep.clearBtn?.addEventListener('click', clearLatestPttepFeed);

  loadPttepImportStatus()
    .then(importState => {
      if (importState?.running) {
        pttep.loading.classList.remove('hidden');
        setPttepBusy(true);
        renderPttepImportProgress(importState);
        window.clearInterval(pttepPollTimer);
        pttepPollTimer = window.setInterval(() => {
          loadPttepImportStatus()
            .then(nextState => {
              if (nextState) renderPttepImportProgress(nextState);
              if (nextState && !nextState.running) {
                window.clearInterval(pttepPollTimer);
                pttepPollTimer = null;
                pttep.loading.classList.add('hidden');
                setPttepBusy(false);
                loadPttepStatus().catch(() => {});
              }
            })
            .catch(() => {});
        }, 1000);
      }
    })
    .catch(() => {});

  loadPttepStatus().catch(() => {
    if (pttep.tbody) {
      pttep.tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Middleware status is not available.</td></tr>`;
    }
  });

  const posco = {
    runBtn: document.getElementById('crawl-posco-btn'),
    loading: document.getElementById('posco-loading-spinner'),
    results: document.getElementById('posco-results-panel'),
    tbody: document.getElementById('posco-log-tbody'),
    statTotal: document.getElementById('posco-stat-total'),
    statMatched: document.getElementById('posco-stat-matched'),
    statReview: document.getElementById('posco-stat-review'),
    progressFill: document.getElementById('posco-progress-fill'),
    progressStage: document.getElementById('posco-progress-stage'),
    progressPercent: document.getElementById('posco-progress-percent'),
    loadingText: document.getElementById('posco-loading-text'),
    otpContainer: document.getElementById('posco-otp-container'),
    otpInput: document.getElementById('posco-otp-input'),
    otpSubmitBtn: document.getElementById('submit-posco-otp-btn'),
    otpError: document.getElementById('posco-otp-error')
  };

  let poscoPollTimer = null;

  function renderPoscoProgress(status) {
    const percent = Math.max(0, Math.min(100, Number(status?.progress || 0)));
    const stage = status?.status_text || 'Crawling POSCO portal...';

    if (posco.progressFill) posco.progressFill.style.width = `${percent}%`;
    if (posco.progressPercent) posco.progressPercent.textContent = `${percent}%`;
    if (posco.progressStage) posco.progressStage.textContent = stage;
  }

  async function loadPoscoScrapeStatus() {
    const response = await fetch('/api/posco/scrape/status');
    if (!response.ok) throw new Error('Failed to fetch scraper status');
    return await response.json();
  }

  function startPoscoPolling() {
    posco.loading.classList.remove('hidden');
    if (posco.runBtn) posco.runBtn.disabled = true;

    window.clearInterval(poscoPollTimer);
    poscoPollTimer = window.setInterval(async () => {
      try {
        const status = await loadPoscoScrapeStatus();
        if (status) {
          renderPoscoProgress(status);
          
          // Check for OTP state
          if (status.status_text === 'WAITING_FOR_OTP') {
            if (posco.otpContainer.classList.contains('hidden')) {
              posco.otpContainer.classList.remove('hidden');
              posco.otpInput.focus();
            }
          } else {
            posco.otpContainer.classList.add('hidden');
          }

          if (!status.running) {
            // Scraper finished!
            window.clearInterval(poscoPollTimer);
            poscoPollTimer = null;
            posco.loading.classList.add('hidden');
            posco.otpContainer.classList.add('hidden');
            if (posco.runBtn) posco.runBtn.disabled = false;
            await loadPoscoLatest();
          }
        }
      } catch (err) {
        console.error('Error polling POSCO status:', err);
      }
    }, 1500);
  }

  posco.runBtn?.addEventListener('click', async () => {
    const forceLogin = document.getElementById('posco-login-toggle')?.checked === true;
    const targetRfqNo = document.getElementById('target-rfq-no')?.value.trim();
    
    // Disable button immediately and show loader
    posco.runBtn.disabled = true;
    posco.loading.classList.remove('hidden');
    renderPoscoProgress({ progress: 5, status_text: targetRfqNo ? `Initializing POSCO scraper for RFQ ${targetRfqNo}...` : 'Initializing POSCO portal scraper...' });

    try {
      // Hardcode mock=false as the demo mode toggle is removed
      let url = `/api/posco/scrape?mock=false&login=${forceLogin}`;
      if (targetRfqNo) {
        url += `&rfq_no=${encodeURIComponent(targetRfqNo)}`;
      }
      
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `POSCO scrape failed (${response.status})`);
      }
      
      // Start polling to monitor the background scraper progress
      startPoscoPolling();
    } catch (err) {
      alert(`POSCO scraper error: ${err.message}`);
      posco.loading.classList.add('hidden');
      posco.runBtn.disabled = false;
    }
  });

  posco.otpSubmitBtn?.addEventListener('click', async () => {
    const otp = posco.otpInput.value.trim();
    if (!otp) {
      posco.otpError.textContent = 'Please enter an OTP code.';
      posco.otpError.classList.remove('hidden');
      return;
    }
    
    posco.otpError.classList.add('hidden');
    posco.otpSubmitBtn.disabled = true;
    posco.otpSubmitBtn.textContent = 'Submitting...';

    try {
      const response = await fetch('/api/posco/submit-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to submit OTP');
      }
      
      // Success, hide box
      posco.otpContainer.classList.add('hidden');
      posco.otpInput.value = '';
    } catch (err) {
      posco.otpError.textContent = err.message;
      posco.otpError.classList.remove('hidden');
    } finally {
      posco.otpSubmitBtn.disabled = false;
      posco.otpSubmitBtn.textContent = 'Submit OTP';
    }
  });

  async function loadPoscoLatest() {
    try {
      const response = await fetch('/api/posco/latest');
      if (response.ok) {
        const payload = await response.json();
        if (payload.success && payload.bids && payload.bids.length > 0) {
          renderPoscoResults(payload.bids);
        }
      }
    } catch (err) {
      console.warn('Failed to load latest POSCO results:', err);
    }
  }

  function renderPoscoResults(activeBids) {
    const rows = Array.isArray(activeBids) ? activeBids : [];
    const totalLines = rows.reduce((sum, item) => sum + ((item.items || []).length || 0), 0);
    const multiLineRfqs = rows.filter(item => ((item.items || []).length || 0) > 1).length;
    posco.statTotal.textContent = rows.length;
    posco.statMatched.textContent = totalLines;
    posco.statReview.textContent = multiLineRfqs;

    if (!rows.length) {
      posco.tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">No active POSCO RFQs found.</td></tr>`;
    } else {
      posco.tbody.innerHTML = rows.map((item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td class="mono-cell">${escapeHtml(item.rfq_no || '')}</td>
          <td class="left-cell">${escapeHtml(item.subject || '')}</td>
          <td>${escapeHtml(item.drafter || '')}</td>
          <td>${escapeHtml(item.regi_date || '')}</td>
          <td>${escapeHtml(item.close_date || '')}</td>
          <td><span class="badge badge-info">Fetched</span></td>
          <td>${escapeHtml((item.items || []).length)} lines</td>
        </tr>
      `).join('');
    }

    posco.results.classList.remove('hidden');
  }

  // Check on load if POSCO scraper is already running in the background
  loadPoscoScrapeStatus()
    .then(status => {
      if (status && status.running) {
        startPoscoPolling();
      } else {
        loadPoscoLatest();
      }
    })
    .catch(() => {
      loadPoscoLatest();
    });
});
