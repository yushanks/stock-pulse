document.addEventListener("DOMContentLoaded", () => {
    let currentMarket = "JP";
    let allResults = [];
    let priceChart = null;

    const scanBtn = document.getElementById("scanBtn");
    const scanStatus = document.getElementById("scanStatus");
    const loadingOverlay = document.getElementById("loadingOverlay");
    const resultsHeader = document.getElementById("resultsHeader");
    const resultsGrid = document.getElementById("resultsGrid");
    const resultCount = document.getElementById("resultCount");
    const scanTime = document.getElementById("scanTime");
    const modalOverlay = document.getElementById("modalOverlay");
    const modalContent = document.getElementById("modalContent");
    const modalClose = document.getElementById("modalClose");
    const themesGrid = document.getElementById("themesGrid");

    loadThemes();

    document.querySelectorAll(".market-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".market-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentMarket = btn.dataset.market;
        });
    });

    scanBtn.addEventListener("click", startScan);
    modalClose.addEventListener("click", closeModal);
    modalOverlay.addEventListener("click", (e) => {
        if (e.target === modalOverlay) closeModal();
    });

    document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            applyFilter(btn.dataset.filter);
        });
    });

    async function loadThemes() {
        try {
            const res = await fetch("/api/themes");
            const themes = await res.json();
            themesGrid.innerHTML = themes.map(t => `
                <div class="theme-card">
                    <div class="theme-name">${t.name}</div>
                    <div class="theme-outlook">${t.outlook}</div>
                    <div class="theme-tickers">
                        ${t.tickers.slice(0, 6).map(tk => `<span class="theme-ticker">${tk}</span>`).join("")}
                        ${t.tickers.length > 6 ? `<span class="theme-ticker">+${t.tickers.length - 6}</span>` : ""}
                    </div>
                </div>
            `).join("");
        } catch (e) {
            console.error("Failed to load themes:", e);
        }
    }

    let progressInterval = null;

    function showLoading() {
        loadingOverlay.style.display = "block";
        loadingOverlay.innerHTML = `
            <div class="loading-content">
                <div class="loading-spinner"></div>
                <p class="loading-text">市場をスキャンしています...</p>
                <p class="loading-sub" id="loadingProgress">株価データを一括ダウンロード中...</p>
                <div style="width:300px;height:8px;background:var(--bg-surface);border-radius:4px;margin-top:12px;overflow:hidden;">
                    <div id="progressBar" style="width:0%;height:100%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-radius:4px;transition:width 0.5s;"></div>
                </div>
                <p id="progressPct" style="font-size:13px;color:var(--text-muted);margin-top:6px;">0%</p>
            </div>
        `;
    }

    function updateProgress(prog) {
        const progressEl = document.getElementById("loadingProgress");
        if (progressEl && prog.message) {
            progressEl.textContent = prog.message;
        }
        if (prog.total > 0) {
            const pct = Math.round((prog.current / prog.total) * 100);
            const barEl = document.getElementById("progressBar");
            if (barEl) barEl.style.width = pct + "%";
            const pctEl = document.getElementById("progressPct");
            if (pctEl) pctEl.textContent = pct + "%";
        }
    }

    async function pollUntilDone() {
        return new Promise((resolve, reject) => {
            progressInterval = setInterval(async () => {
                try {
                    const res = await fetch("/api/progress");
                    const prog = await res.json();
                    updateProgress(prog);

                    if (prog.status === "done") {
                        clearInterval(progressInterval);
                        progressInterval = null;
                        resolve();
                    } else if (prog.status === "error") {
                        clearInterval(progressInterval);
                        progressInterval = null;
                        reject(new Error(prog.message || "スキャン中にエラーが発生しました"));
                    }
                } catch (e) { /* ignore network blip */ }
            }, 1500);
        });
    }

    async function startScan() {
        scanBtn.disabled = true;
        scanBtn.innerHTML = '<span class="scan-icon">⏳</span>分析中...';
        scanStatus.style.display = "none";
        showLoading();
        resultsHeader.style.display = "none";
        resultsGrid.innerHTML = "";

        try {
            const kickoff = await fetch("/api/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ market: currentMarket }),
            });
            const kickData = await kickoff.json();

            if (!kickoff.ok) {
                throw new Error(kickData.error || `サーバーエラー (${kickoff.status})`);
            }

            await pollUntilDone();

            const resData = await fetch(`/api/results/${currentMarket}`);
            const data = await resData.json();

            allResults = data.results || [];

            loadingOverlay.style.display = "none";
            resultsHeader.style.display = "block";

            const scanDate = data.scannedAt ? new Date(data.scannedAt) : new Date();
            resultCount.textContent = `${allResults.length}銘柄を分析`;
            scanTime.textContent = `スキャン完了: ${scanDate.toLocaleString("ja-JP")}`;

            renderResults(allResults);
        } catch (e) {
            console.error("Scan failed:", e);
            loadingOverlay.style.display = "none";
            scanStatus.style.display = "block";
            scanStatus.innerHTML = `<div class="status-idle"><p style="color:var(--red)">エラーが発生しました。再度お試しください。</p><p class="status-sub">${e.message}</p></div>`;
        } finally {
            if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
            scanBtn.disabled = false;
            scanBtn.innerHTML = '<span class="scan-icon">⚡</span>スキャン開始';
        }
    }

    function applyFilter(filter) {
        if (filter === "all") {
            renderResults(allResults);
            return;
        }
        let filtered;
        switch (filter) {
            case "strong-buy":
                filtered = allResults.filter(s => s.timingColor === "strong-buy");
                break;
            case "buy":
                filtered = allResults.filter(s => s.timingColor === "buy" || s.timingColor === "strong-buy");
                break;
            case "value":
                filtered = allResults.filter(s => s.valueScore >= 30);
                break;
            case "growth":
                filtered = allResults.filter(s => s.growthScore >= 30);
                break;
            default:
                filtered = allResults;
        }
        renderResults(filtered);
    }

    function renderResults(results) {
        resultsGrid.innerHTML = results.map(stock => {
            const scoreClass = stock.totalScore >= 60 ? "score-high" : stock.totalScore >= 35 ? "score-mid" : "score-low";
            const valueWidth = Math.min(stock.valueScore, 85);
            const growthWidth = Math.min(stock.growthScore, 85);
            const timingWidth = Math.min(stock.timingScore, 85);
            const currencySymbol = stock.currency === "JPY" ? "¥" : "$";

            return `
                <div class="stock-card ${stock.timingColor}" onclick='showDetail(${JSON.stringify(stock).replace(/'/g, "&#39;")})'>
                    <div class="total-score-badge ${scoreClass}">${stock.totalScore}</div>
                    <div class="card-header">
                        <div>
                            <div class="card-ticker">${stock.ticker}</div>
                            <div class="card-name">${stock.name}</div>
                        </div>
                    </div>
                    <div class="card-price">${currencySymbol}${stock.currentPrice.toLocaleString()}</div>
                    <div class="card-price-change" style="color: ${stock.fromHigh < -15 ? 'var(--green)' : 'var(--text-muted)'}">
                        高値から ${stock.fromHigh !== null ? stock.fromHigh.toFixed(1) : '-'}%
                    </div>
                    <div class="card-metrics">
                        <div class="metric">
                            <div class="metric-label">PER</div>
                            <div class="metric-value">${stock.pe !== null ? stock.pe : '-'}</div>
                        </div>
                        <div class="metric">
                            <div class="metric-label">PBR</div>
                            <div class="metric-value">${stock.pb !== null ? stock.pb : '-'}</div>
                        </div>
                        <div class="metric">
                            <div class="metric-label">RSI</div>
                            <div class="metric-value" style="color: ${stock.rsi < 30 ? 'var(--green)' : stock.rsi > 70 ? 'var(--red)' : 'var(--text)'}">
                                ${stock.rsi !== null ? stock.rsi : '-'}
                            </div>
                        </div>
                    </div>
                    <div class="card-scores">
                        <div class="score-bar"><div class="score-bar-fill value" style="width:${valueWidth}%"></div></div>
                        <div class="score-bar"><div class="score-bar-fill growth" style="width:${growthWidth}%"></div></div>
                        <div class="score-bar"><div class="score-bar-fill timing" style="width:${timingWidth}%"></div></div>
                    </div>
                    <div class="score-labels">
                        <span class="score-label"><span class="score-dot value"></span>割安</span>
                        <span class="score-label"><span class="score-dot growth"></span>成長</span>
                        <span class="score-label"><span class="score-dot timing"></span>タイミング</span>
                    </div>
                    ${stock.themes.length > 0 ? `
                        <div class="card-themes">
                            ${stock.themes.map(t => `<span class="card-theme">${t.name}</span>`).join("")}
                        </div>
                    ` : ""}
                    <div style="margin-top:10px;text-align:center;">
                        <span class="card-signal signal-${stock.timingColor}">${stock.timingSignal}</span>
                    </div>
                </div>
            `;
        }).join("");
    }

    window.showDetail = function(stock) {
        const currencySymbol = stock.currency === "JPY" ? "¥" : "$";

        const timingReasons = [];
        if (stock.rsi !== null) {
            if (stock.rsi < 30) timingReasons.push({ text: `RSI ${stock.rsi} → 売られすぎ水準。反発の可能性が高い`, cls: "indicator-green" });
            else if (stock.rsi < 40) timingReasons.push({ text: `RSI ${stock.rsi} → 売られすぎに近い水準`, cls: "indicator-green" });
            else if (stock.rsi < 50) timingReasons.push({ text: `RSI ${stock.rsi} → やや売り圧力が優勢`, cls: "indicator-yellow" });
            else if (stock.rsi > 70) timingReasons.push({ text: `RSI ${stock.rsi} → 買われすぎ水準。調整注意`, cls: "indicator-red" });
            else timingReasons.push({ text: `RSI ${stock.rsi} → 中立`, cls: "indicator-gray" });
        }
        if (stock.macdCross === "bullish") timingReasons.push({ text: "MACD: ゴールデンクロス → 上昇トレンド転換の兆し", cls: "indicator-green" });
        else timingReasons.push({ text: "MACD: デッドクロス → 下降トレンド継続中", cls: "indicator-red" });
        if (stock.priceVsSma50 < -5) timingReasons.push({ text: `50日移動平均から${stock.priceVsSma50.toFixed(1)}%乖離 → 反発余地あり`, cls: "indicator-green" });
        else if (stock.priceVsSma50 > 5) timingReasons.push({ text: `50日移動平均から${stock.priceVsSma50.toFixed(1)}%乖離 → 上方乖離（過熱気味）`, cls: "indicator-yellow" });
        if (stock.priceVsSma200 !== null) {
            if (stock.priceVsSma200 < -10) timingReasons.push({ text: `200日移動平均から${stock.priceVsSma200.toFixed(1)}%乖離 → 大きく割安`, cls: "indicator-green" });
        }
        if (stock.fromHigh !== null && stock.fromHigh < -20) timingReasons.push({ text: `年初来高値から${stock.fromHigh.toFixed(1)}% → 大幅調整済みで買い場の可能性`, cls: "indicator-green" });

        const valueReasons = [];
        if (stock.pe !== null) {
            if (stock.pe < 10) valueReasons.push({ text: `PER ${stock.pe} → 非常に割安`, cls: "indicator-green" });
            else if (stock.pe < 15) valueReasons.push({ text: `PER ${stock.pe} → 割安`, cls: "indicator-green" });
            else if (stock.pe < 25) valueReasons.push({ text: `PER ${stock.pe} → 適正水準`, cls: "indicator-yellow" });
            else valueReasons.push({ text: `PER ${stock.pe} → 割高`, cls: "indicator-red" });
        }
        if (stock.pb !== null) {
            if (stock.pb < 1.0) valueReasons.push({ text: `PBR ${stock.pb} → 純資産以下で割安`, cls: "indicator-green" });
            else if (stock.pb < 1.5) valueReasons.push({ text: `PBR ${stock.pb} → 適正水準`, cls: "indicator-yellow" });
            else valueReasons.push({ text: `PBR ${stock.pb} → 高め`, cls: "indicator-red" });
        }
        if (stock.peg !== null) {
            if (stock.peg < 1.0) valueReasons.push({ text: `PEG ${stock.peg} → 成長に対して割安`, cls: "indicator-green" });
            else if (stock.peg < 1.5) valueReasons.push({ text: `PEG ${stock.peg} → 適正`, cls: "indicator-yellow" });
        }

        const growthReasons = [];
        if (stock.roe !== null) {
            if (stock.roe > 15) growthReasons.push({ text: `ROE ${stock.roe}% → 高い資本効率`, cls: "indicator-green" });
            else if (stock.roe > 10) growthReasons.push({ text: `ROE ${stock.roe}% → 良好`, cls: "indicator-yellow" });
        }
        if (stock.revenueGrowth !== null) {
            if (stock.revenueGrowth > 20) growthReasons.push({ text: `売上成長率 ${stock.revenueGrowth}% → 高成長`, cls: "indicator-green" });
            else if (stock.revenueGrowth > 10) growthReasons.push({ text: `売上成長率 ${stock.revenueGrowth}% → 安定成長`, cls: "indicator-yellow" });
        }
        if (stock.earningsGrowth !== null) {
            if (stock.earningsGrowth > 20) growthReasons.push({ text: `利益成長率 ${stock.earningsGrowth}% → 高成長`, cls: "indicator-green" });
        }

        const reasonsHtml = (title, reasons) => {
            if (reasons.length === 0) return "";
            return `
                <div class="analysis-section">
                    <div class="analysis-title">${title}</div>
                    ${reasons.map(r => `
                        <div class="analysis-row">
                            <div class="analysis-indicator ${r.cls}"></div>
                            <div>${r.text}</div>
                        </div>
                    `).join("")}
                </div>
            `;
        };

        modalContent.innerHTML = `
            <div class="modal-header">
                <div class="modal-ticker">${stock.ticker}</div>
                <div class="modal-name">${stock.name}</div>
                <div class="modal-info">${stock.sector} / ${stock.industry}</div>
            </div>

            <div class="modal-signal-box ${stock.timingColor}">
                <div class="modal-signal-title">${stock.timingSignal}</div>
                <div class="modal-signal-desc">
                    総合スコア: ${stock.totalScore}点 (割安: ${stock.valueScore} / 成長: ${stock.growthScore} / タイミング: ${stock.timingScore})
                </div>
            </div>

            <div class="modal-grid">
                <div class="modal-metric">
                    <div class="modal-metric-label">現在価格</div>
                    <div class="modal-metric-value">${currencySymbol}${stock.currentPrice.toLocaleString()}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">PER</div>
                    <div class="modal-metric-value">${stock.pe ?? '-'}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">PBR</div>
                    <div class="modal-metric-value">${stock.pb ?? '-'}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">ROE</div>
                    <div class="modal-metric-value">${stock.roe ? stock.roe + '%' : '-'}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">RSI</div>
                    <div class="modal-metric-value" style="color: ${stock.rsi < 30 ? 'var(--green)' : stock.rsi > 70 ? 'var(--red)' : 'inherit'}">${stock.rsi ?? '-'}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">配当利回り</div>
                    <div class="modal-metric-value">${stock.dividendYield ? stock.dividendYield + '%' : '-'}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">時価総額</div>
                    <div class="modal-metric-value">${formatMarketCap(stock.marketCap, stock.currency)}</div>
                </div>
                <div class="modal-metric">
                    <div class="modal-metric-label">年初来高値比</div>
                    <div class="modal-metric-value" style="color: ${stock.fromHigh < -15 ? 'var(--green)' : 'inherit'}">${stock.fromHigh ? stock.fromHigh.toFixed(1) + '%' : '-'}</div>
                </div>
            </div>

            <div class="modal-chart-container">
                <div class="modal-chart-title">90日間の株価推移</div>
                <canvas id="priceChartCanvas" height="200"></canvas>
            </div>

            ${reasonsHtml("📊 買い時シグナル分析", timingReasons)}
            ${reasonsHtml("💰 割安度分析", valueReasons)}
            ${reasonsHtml("📈 成長性分析", growthReasons)}

            ${stock.themes.length > 0 ? `
                <div class="modal-themes">
                    <div class="analysis-title">🌍 関連テーマ・社会情勢</div>
                    ${stock.themes.map(t => `
                        <div class="modal-theme">
                            <div class="modal-theme-name">${t.name}</div>
                            <div class="modal-theme-outlook">${t.outlook}</div>
                        </div>
                    `).join("")}
                </div>
            ` : ""}
        `;

        modalOverlay.style.display = "flex";
        document.body.style.overflow = "hidden";

        if (stock.priceData && stock.priceData.length > 0) {
            renderPriceChart(stock);
        }
    };

    function renderPriceChart(stock) {
        const ctx = document.getElementById("priceChartCanvas");
        if (!ctx) return;

        if (priceChart) priceChart.destroy();

        const labels = stock.priceData.map(d => d.date);
        const prices = stock.priceData.map(d => d.close);

        const gradient = ctx.getContext("2d").createLinearGradient(0, 0, 0, 200);
        gradient.addColorStop(0, "rgba(59, 130, 246, 0.3)");
        gradient.addColorStop(1, "rgba(59, 130, 246, 0)");

        priceChart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    data: prices,
                    borderColor: "#3b82f6",
                    backgroundColor: gradient,
                    borderWidth: 2,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.3,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#1e293b",
                        titleColor: "#f1f5f9",
                        bodyColor: "#94a3b8",
                        borderColor: "#334155",
                        borderWidth: 1,
                        padding: 10,
                        callbacks: {
                            label: ctx => `${stock.currency === 'JPY' ? '¥' : '$'}${ctx.raw.toLocaleString()}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: "rgba(255,255,255,0.05)" },
                        ticks: {
                            color: "#64748b",
                            maxTicksLimit: 8,
                            font: { size: 11 },
                        },
                    },
                    y: {
                        grid: { color: "rgba(255,255,255,0.05)" },
                        ticks: {
                            color: "#64748b",
                            font: { size: 11 },
                            callback: v => `${stock.currency === 'JPY' ? '¥' : '$'}${v.toLocaleString()}`
                        },
                    },
                },
            },
        });
    }

    function closeModal() {
        modalOverlay.style.display = "none";
        document.body.style.overflow = "";
        if (priceChart) {
            priceChart.destroy();
            priceChart = null;
        }
    }

    function formatMarketCap(cap, currency) {
        if (!cap) return "-";
        if (currency === "JPY") {
            if (cap >= 1e12) return (cap / 1e12).toFixed(1) + "兆円";
            if (cap >= 1e8) return (cap / 1e8).toFixed(0) + "億円";
            return cap.toLocaleString() + "円";
        }
        if (cap >= 1e12) return "$" + (cap / 1e12).toFixed(1) + "T";
        if (cap >= 1e9) return "$" + (cap / 1e9).toFixed(1) + "B";
        if (cap >= 1e6) return "$" + (cap / 1e6).toFixed(0) + "M";
        return "$" + cap.toLocaleString();
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeModal();
    });
});
