// ===============================================
// Vectoria.ai - Complete Modern JavaScript
// ===============================================

;(() => {
  // === Configuration ===
  const CONFIG = {
    API_BASE_URL: window.location.hostname === "localhost" ? "http://localhost:3001/api" : "/api",
    MAX_PROMPT_LENGTH: 800,
    TOAST_DURATION: 4000,
    STORAGE_KEY: "vectoria_history",
    MAX_HISTORY: 30,
    DEBOUNCE_DELAY: 300,
  }

  // === State Management ===
  const state = {
    isGenerating: false,
    currentSvg: null,
    currentPrompt: "",
    enhancedPrompt: "",
    generationTime: 0,
    history: [],
    theme: "dark",
    abortController: null,
  }

  // === DOM Elements ===
  const elements = {}

  // === Initialize ===
  document.addEventListener("DOMContentLoaded", init)

  function init() {
    cacheDOMElements()
    setupEventListeners()
    loadTheme()
    loadHistory()
    checkServerStatus()
    animateHeroMetrics()
    initializeAnimations()
  }

  // === Cache DOM Elements ===
  function cacheDOMElements() {
    // Navigation
    elements.themeToggle = document.getElementById("themeToggle")
    elements.mobileNavToggle = document.getElementById("mobileNavToggle")
    elements.mobileNav = document.getElementById("mobileNav")
    elements.serverStatus = document.getElementById("serverStatus")

    // Hero
    elements.heroStart = document.getElementById("heroStart")
    elements.heroDemo = document.getElementById("heroDemo")

    // Form
    elements.form = document.getElementById("generationForm")
    elements.promptInput = document.getElementById("promptInput")
    elements.charCounter = document.getElementById("charCounter")
    elements.styleSelect = document.getElementById("styleSelect")
    elements.complexitySelect = document.getElementById("complexitySelect")
    elements.colorSelect = document.getElementById("colorSelect")
    elements.enhanceBtn = document.getElementById("enhanceBtn")
    elements.generateBtn = document.getElementById("generateBtn")
    elements.luckyBtn = document.getElementById("luckyBtn")
    elements.clearAll = document.getElementById("clearAll")

    // Output
    elements.loadingState = document.getElementById("loadingState")
    elements.loadingStatus = document.getElementById("loadingStatus")
    elements.progressFill = document.getElementById("progressFill")
    elements.resultDisplay = document.getElementById("resultDisplay")
    elements.emptyState = document.getElementById("emptyState")
    elements.svgContainer = document.getElementById("svgContainer")

    // Result Actions
    elements.downloadSvg = document.getElementById("downloadSvg")
    elements.copyCode = document.getElementById("copyCode")
    elements.editDesign = document.getElementById("editDesign")
    elements.regenerateBtn = document.getElementById("regenerateBtn")

    // Result Info
    elements.genTime = document.getElementById("genTime")
    elements.genStyle = document.getElementById("genStyle")
    elements.qualityScore = document.getElementById("qualityScore")
    elements.fileSize = document.getElementById("fileSize")
    elements.originalPrompt = document.getElementById("originalPrompt")
    elements.enhancedPrompt = document.getElementById("enhancedPrompt")
    elements.svgCode = document.getElementById("svgCode")
    elements.colorPalette = document.getElementById("colorPalette")

    // History
    elements.historyTrack = document.getElementById("historyTrack")
    elements.emptyHistory = document.getElementById("emptyHistory")
    elements.clearHistory = document.getElementById("clearHistory")

    // Other
    elements.toastContainer = document.getElementById("toastContainer")
    elements.shortcutsModal = document.getElementById("shortcutsModal")
  }

  // === Event Listeners ===
  function setupEventListeners() {
    // Theme Toggle
    elements.themeToggle?.addEventListener("click", toggleTheme)

    // Mobile Navigation
    elements.mobileNavToggle?.addEventListener("click", toggleMobileNav)

    // Hero Actions
    elements.heroStart?.addEventListener("click", () => {
      document.getElementById("create")?.scrollIntoView({ behavior: "smooth" })
    })

    elements.heroDemo?.addEventListener("click", () => {
      showToast("Demo coming soon!", "info")
    })

    // Form
    elements.form?.addEventListener("submit", handleGenerate)
    elements.promptInput?.addEventListener("input", updateCharCounter)
    elements.enhanceBtn?.addEventListener("click", enhancePrompt)
    elements.luckyBtn?.addEventListener("click", feelingLucky)
    elements.clearAll?.addEventListener("click", clearAll)

    // Templates
    document.querySelectorAll(".template-card").forEach((card) => {
      card.addEventListener("click", () => {
        const template = card.dataset.template
        if (template) {
          elements.promptInput.value = template
          updateCharCounter()
          showToast("Template loaded!", "success")
        }
      })
    })

    // Result Actions
    elements.downloadSvg?.addEventListener("click", downloadSVG)
    elements.copyCode?.addEventListener("click", copySVGCode)
    elements.editDesign?.addEventListener("click", () => {
      showToast("Edit feature coming soon!", "info")
    })
    elements.regenerateBtn?.addEventListener("click", regenerate)

    // Tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab))
    })

    // Background Options
    document.querySelectorAll(".bg-option").forEach((option) => {
      option.addEventListener("click", () => changeBackground(option.dataset.bg))
    })

    // Export Options
    document.querySelectorAll(".export-btn").forEach((btn) => {
      btn.addEventListener("click", () => exportDesign(btn.dataset.format))
    })

    // History
    elements.clearHistory?.addEventListener("click", clearHistory)

    // Keyboard Shortcuts
    document.addEventListener("keydown", handleKeyboard)

    // Close mobile nav on link click
    document.querySelectorAll(".mobile-nav-link").forEach((link) => {
      link.addEventListener("click", () => {
        elements.mobileNav?.classList.remove("active")
        elements.mobileNavToggle?.classList.remove("active")
      })
    })
  }

  // === Theme Management ===
  function loadTheme() {
    const savedTheme = localStorage.getItem("vectoria_theme") || "dark"
    state.theme = savedTheme
    document.documentElement.setAttribute("data-theme", savedTheme)
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark"
    document.documentElement.setAttribute("data-theme", state.theme)
    localStorage.setItem("vectoria_theme", state.theme)
  }

  // === Mobile Navigation ===
  function toggleMobileNav() {
    elements.mobileNav?.classList.toggle("active")
    elements.mobileNavToggle?.classList.toggle("active")
  }

  // === Server Status Check ===
  async function checkServerStatus() {
    try {
      const response = await fetch(`${CONFIG.API_BASE_URL}/health`)
      updateServerStatus(response.ok ? "online" : "offline")
    } catch {
      updateServerStatus("offline")
    }
  }

  function updateServerStatus(status) {
    if (!elements.serverStatus) return

    elements.serverStatus.classList.toggle("offline", status === "offline")
    const statusText = elements.serverStatus.querySelector(".status-text")
    if (statusText) {
      statusText.textContent = status === "online" ? "API Online" : "API Offline"
    }
  }

  // === Animations ===
  function animateHeroMetrics() {
    document.querySelectorAll("[data-target]").forEach((el) => {
      const target = Number.parseFloat(el.dataset.target)
      const duration = 2000
      const start = Date.now()

      function update() {
        const progress = Math.min((Date.now() - start) / duration, 1)
        const value = Math.floor(target * easeOutQuad(progress))
        el.textContent = value.toLocaleString()

        if (progress < 1) requestAnimationFrame(update)
      }

      update()
    })
  }

  function initializeAnimations() {
    // Floating shapes animation
    const shapes = document.querySelectorAll(".shape")
    shapes.forEach((shape, i) => {
      shape.style.animationDelay = `${i * 0.5}s`
    })
  }

  // === Form Functions ===
  function updateCharCounter() {
    const length = elements.promptInput.value.length
    elements.charCounter.textContent = `${length} / ${CONFIG.MAX_PROMPT_LENGTH}`

    elements.charCounter.classList.toggle("warning", length > 700)
    elements.charCounter.classList.toggle("error", length > 750)
  }

  async function enhancePrompt() {
    const prompt = elements.promptInput.value.trim()
    if (!prompt) {
      showToast("Enter a prompt first", "error")
      return
    }

    elements.enhanceBtn.disabled = true
    elements.enhanceBtn.textContent = "Enhancing..."

    try {
      // Simulate enhancement - in production, call actual API
      await sleep(1000)
      const enhanced = `${prompt}, professional vector design, high quality, scalable`
      elements.promptInput.value = enhanced
      updateCharCounter()
      showToast("Prompt enhanced!", "success")
    } catch {
      showToast("Enhancement failed", "error")
    } finally {
      elements.enhanceBtn.disabled = false
      elements.enhanceBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
        <span>Enhance</span>
      `
    }
  }

  function feelingLucky() {
    const prompts = [
      "Modern tech startup logo with geometric shapes",
      "Abstract art with flowing gradients",
      "Minimalist nature-inspired design",
      "Retro 80s synthwave pattern",
      "Cute robot character illustration",
    ]

    elements.promptInput.value = prompts[Math.floor(Math.random() * prompts.length)]
    updateCharCounter()
    setTimeout(() => elements.form.dispatchEvent(new Event("submit")), 500)
  }

  function clearAll() {
    elements.promptInput.value = ""
    elements.styleSelect.value = "auto"
    elements.complexitySelect.value = "moderate"
    elements.colorSelect.value = "auto"
    updateCharCounter()

    elements.resultDisplay?.classList.remove("active")
    elements.emptyState?.classList.remove("hidden")

    state.currentSvg = null
    state.currentPrompt = ""
  }

  // === Generation ===
  async function handleGenerate(e) {
    e?.preventDefault()

    const prompt = elements.promptInput.value.trim()
    if (!prompt) {
      showToast("Please enter a prompt", "error")
      return
    }

    if (state.isGenerating) {
      cancelGeneration()
      return
    }

    state.isGenerating = true
    state.currentPrompt = prompt
    state.abortController = new AbortController()

    showLoading(true)
    const startTime = Date.now()

    try {
      const response = await fetch(`${CONFIG.API_BASE_URL}/generate-svg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userPrompt: prompt,
          style: elements.styleSelect?.value,
          complexity: elements.complexitySelect?.value,
          colorMode: elements.colorSelect?.value,
        }),
        signal: state.abortController.signal,
      })

      if (!response.ok) throw new Error("Generation failed")

      const data = await response.json()
      state.generationTime = Date.now() - startTime

      displayResult(data)
      addToHistory(data)
      showToast("Design created successfully!", "success")
    } catch (error) {
      if (error.name === "AbortError") {
        showToast("Generation cancelled", "info")
      } else {
        showToast("Failed to generate design", "error")
      }
    } finally {
      state.isGenerating = false
      showLoading(false)
    }
  }

  function cancelGeneration() {
    if (state.abortController) {
      state.abortController.abort()
    }
  }

  function showLoading(show) {
    if (show) {
      elements.loadingState?.classList.add("active")
      elements.resultDisplay?.classList.remove("active")
      elements.emptyState?.classList.add("hidden")
      animateProgress()
    } else {
      elements.loadingState?.classList.remove("active")
    }
  }

  function animateProgress() {
    let progress = 0
    const interval = setInterval(() => {
      progress += 10
      if (elements.progressFill) {
        elements.progressFill.style.width = `${Math.min(progress, 90)}%`
      }
      if (progress >= 90 || !state.isGenerating) clearInterval(interval)
    }, 200)
  }

  // === Display Result ===
  function displayResult(data) {
    state.currentSvg = data.svgCode
    state.enhancedPrompt = data.enhancedPrompt

    // Display SVG
    if (elements.svgContainer) {
      elements.svgContainer.innerHTML = data.svgCode || `<img src="${data.rasterImageUrl}" alt="Generated Design">`
    }

    // Update info
    if (elements.genTime) elements.genTime.textContent = formatTime(state.generationTime)
    if (elements.genStyle) elements.genStyle.textContent = data.style || "Auto"
    if (elements.qualityScore)
      elements.qualityScore.textContent = data.quality?.score ? `${Math.round(data.quality.score * 100)}%` : "—"
    if (elements.fileSize)
      elements.fileSize.textContent = data.svgCode ? formatSize(new Blob([data.svgCode]).size) : "—"
    if (elements.originalPrompt) elements.originalPrompt.textContent = state.currentPrompt
    if (elements.enhancedPrompt) elements.enhancedPrompt.textContent = data.enhancedPrompt || "—"
    if (elements.svgCode) elements.svgCode.textContent = data.svgCode || "<!-- No code -->"

    // Extract colors
    if (data.svgCode) {
      const colors = extractColors(data.svgCode)
      displayColors(colors)
    }

    // Show result
    elements.resultDisplay?.classList.add("active")
    elements.emptyState?.classList.add("hidden")
  }

  function extractColors(svg) {
    const colors = new Set()
    const regex = /(?:fill|stroke)="([^"]+)"/g
    let match
    while ((match = regex.exec(svg))) {
      if (match[1] && !match[1].includes("url") && match[1] !== "none") {
        colors.add(match[1])
      }
    }
    return Array.from(colors)
  }

  function displayColors(colors) {
    if (!elements.colorPalette) return

    elements.colorPalette.innerHTML = colors
      .map(
        (color) => `
      <div class="color-swatch" onclick="copyColor('${color}')">
        <div class="color-box" style="background: ${color}"></div>
        <span class="color-code">${color}</span>
      </div>
    `,
      )
      .join("")
  }

  window.copyColor = (color) => {
    navigator.clipboard.writeText(color)
    showToast(`Copied ${color}`, "success")
  }

  // === Actions ===
  function downloadSVG() {
    if (!state.currentSvg) {
      showToast("No SVG to download", "error")
      return
    }

    const blob = new Blob([state.currentSvg], { type: "image/svg+xml" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `vectoria-${Date.now()}.svg`
    a.click()
    URL.revokeObjectURL(url)

    showToast("SVG downloaded!", "success")
  }

  function copySVGCode() {
    if (!state.currentSvg) {
      showToast("No SVG to copy", "error")
      return
    }

    navigator.clipboard.writeText(state.currentSvg)
    showToast("SVG code copied!", "success")
  }

  function regenerate() {
    if (state.currentPrompt) {
      elements.form.dispatchEvent(new Event("submit"))
    }
  }

  function exportDesign(format) {
    if (!state.currentSvg) {
      showToast("No design to export", "error")
      return
    }

    switch (format) {
      case "svg":
        downloadSVG()
        break
      case "png":
        convertToPNG()
        break
      case "pdf":
        showToast("PDF export coming soon", "info")
        break
      case "react":
        copyAsReactComponent()
        break
    }
  }

  function convertToPNG() {
    // Simple PNG conversion
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")
    const img = new Image()

    img.onload = () => {
      canvas.width = 1024
      canvas.height = 1024
      ctx.fillStyle = "white"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `vectoria-${Date.now()}.png`
        a.click()
        URL.revokeObjectURL(url)
        showToast("PNG downloaded!", "success")
      })
    }

    img.src = "data:image/svg+xml;base64," + btoa(state.currentSvg)
  }

  function copyAsReactComponent() {
    const componentCode = `
const VectoriaDesign = () => (
  ${state.currentSvg.replace(/class=/g, "className=")}
);

export default VectoriaDesign;`

    navigator.clipboard.writeText(componentCode)
    showToast("Copied as React component!", "success")
  }

  // === UI Functions ===
  function switchTab(tabName) {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName)
    })

    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `${tabName}Tab`)
    })
  }

  function changeBackground(bg) {
    document.querySelectorAll(".bg-option").forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.bg === bg)
    })

    const container = elements.svgContainer
    if (!container) return

    container.classList.remove("checkers", "white", "dark", "gradient")

    switch (bg) {
      case "checkers":
        container.classList.add("checkers")
        break
      case "white":
        container.style.background = "white"
        break
      case "dark":
        container.style.background = "var(--bg-base)"
        break
      case "gradient":
        container.style.background = "var(--gradient-primary)"
        break
    }
  }

  // === History ===
  function loadHistory() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE_KEY)
      state.history = saved ? JSON.parse(saved) : []
      updateHistoryDisplay()
    } catch {
      state.history = []
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state.history))
    } catch {}
  }

  function addToHistory(data) {
    const item = {
      id: Date.now(),
      prompt: state.currentPrompt,
      svg: data.svgCode,
      image: data.rasterImageUrl,
      date: new Date().toISOString(),
    }

    state.history.unshift(item)
    if (state.history.length > CONFIG.MAX_HISTORY) {
      state.history.pop()
    }

    saveHistory()
    updateHistoryDisplay()
  }

  function updateHistoryDisplay() {
    if (!elements.historyTrack) return

    if (state.history.length === 0) {
      elements.historyTrack.style.display = "none"
      elements.emptyHistory?.classList.add("active")
      return
    }

    elements.historyTrack.style.display = "flex"
    elements.emptyHistory?.classList.remove("active")

    elements.historyTrack.innerHTML = state.history
      .map(
        (item) => `
      <div class="history-item" data-id="${item.id}">
        <div class="history-preview">
          ${item.svg ? item.svg : `<img src="${item.image}" alt="">`}
        </div>
        <div class="history-info">
          <div class="history-prompt">${escapeHtml(item.prompt)}</div>
          <div class="history-date">${formatDate(item.date)}</div>
        </div>
      </div>
    `,
      )
      .join("")

    // Add click handlers
    elements.historyTrack.querySelectorAll(".history-item").forEach((el) => {
      el.addEventListener("click", () => loadFromHistory(el.dataset.id))
    })
  }

  function loadFromHistory(id) {
    const item = state.history.find((h) => h.id == id)
    if (!item) return

    elements.promptInput.value = item.prompt
    updateCharCounter()

    displayResult({
      svgCode: item.svg,
      rasterImageUrl: item.image,
      enhancedPrompt: "",
    })

    showToast("Loaded from history", "success")
  }

  function clearHistory() {
    if (!confirm("Clear all history?")) return

    state.history = []
    saveHistory()
    updateHistoryDisplay()
    showToast("History cleared", "success")
  }

  // === Toast Notifications ===
  function showToast(message, type = "info") {
    const toast = document.createElement("div")
    toast.className = `toast ${type}`

    const icons = {
      success: "✓",
      error: "✕",
      info: "ℹ",
    }

    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
      <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `

    elements.toastContainer?.appendChild(toast)

    setTimeout(() => toast.remove(), CONFIG.TOAST_DURATION)
  }

  // === Keyboard Shortcuts ===
  function handleKeyboard(e) {
    // Ctrl/Cmd + Enter: Generate
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault()
      elements.form?.dispatchEvent(new Event("submit"))
    }

    // Ctrl/Cmd + K: Focus prompt
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault()
      elements.promptInput?.focus()
    }

    // Ctrl/Cmd + D: Download
    if ((e.ctrlKey || e.metaKey) && e.key === "d") {
      e.preventDefault()
      downloadSVG()
    }

    // Escape: Cancel generation
    if (e.key === "Escape" && state.isGenerating) {
      cancelGeneration()
    }
  }

  // === Utility Functions ===
  function formatTime(ms) {
    return (ms / 1000).toFixed(1) + "s"
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B"
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
    return (bytes / (1024 * 1024)).toFixed(1) + " MB"
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now - date

    if (diff < 60000) return "Just now"
    if (diff < 3600000) return Math.floor(diff / 60000) + " min ago"
    if (diff < 86400000) return Math.floor(diff / 3600000) + " hours ago"
    return date.toLocaleDateString()
  }

  function escapeHtml(text) {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
  }

  function easeOutQuad(t) {
    return t * (2 - t)
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
})()
