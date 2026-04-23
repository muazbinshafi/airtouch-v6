import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { InitScreen } from "@/components/omnipoint/InitScreen";
import { StatusBar } from "@/components/omnipoint/StatusBar";
import { SensorPanel } from "@/components/omnipoint/SensorPanel";
import { TelemetryPanel } from "@/components/omnipoint/TelemetryPanel";
import { BridgeTroubleshooter } from "@/components/omnipoint/BridgeTroubleshooter";
import { ControlModeBar, type ControlMode } from "@/components/omnipoint/ControlModeBar";
import { GestureEngine, defaultConfig, type EngineConfig } from "@/lib/omnipoint/GestureEngine";
import { HIDBridge } from "@/lib/omnipoint/HIDBridge";
import { TelemetryStore } from "@/lib/omnipoint/TelemetryStore";
import { ThemeSettings } from "@/components/ThemeSettings";
import { PaintToolbar } from "@/components/omnipoint/PaintToolbar";
import { GestureSettingsPanel } from "@/components/omnipoint/GestureSettingsPanel";
import { useBrowserCursor } from "@/hooks/useBrowserCursor";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Gauge, Wand2 } from "lucide-react";
import { CalibrationWizard } from "@/components/omnipoint/CalibrationWizard";
import { PerformanceHUD } from "@/components/omnipoint/PerformanceHUD";
import { GestureTour } from "@/components/omnipoint/GestureTour";
import { HelpCircle } from "lucide-react";
import { TelemetryQualityBadge } from "@/components/omnipoint/TelemetryQualityBadge";
import { PinchConfidenceOverlay } from "@/components/omnipoint/PinchConfidenceOverlay";
import { onEngineConfigApply } from "@/lib/omnipoint/GestureProfiles";
import { GestureSettingsStore } from "@/lib/omnipoint/GestureSettings";

const Demo = () => {
  const [initialized, setInitialized] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [status, setStatus] = useState("Awaiting operator input...");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [troubleshooterOpen, setTroubleshooterOpen] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [pinchOverlayOn, setPinchOverlayOn] = useState(false);

  const [config, setConfigState] = useState<EngineConfig>(defaultConfig);
  const [bridgeUrl, setBridgeUrl] = useState("ws://localhost:8765");
  const [controlMode, setControlMode] = useState<ControlMode>("browser");

  const engineRef = useRef<GestureEngine | null>(null);
  const bridgeRef = useRef<HIDBridge | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const browserCursor = useBrowserCursor(initialized && controlMode === "browser", "pointer");

  useEffect(() => {
    document.title = "Live Sensor — OmniPoint HCI";
  }, []);

  // When a profile carrying an engineConfig is activated (e.g. after cloud
  // sync hydrates on sign-in), apply that calibration to the live engine.
  useEffect(() => {
    onEngineConfigApply((cfg) => {
      setConfigState((prev) => {
        const next = { ...prev, ...cfg };
        if (engineRef.current) engineRef.current.config = next;
        return next;
      });
    });
    return () => onEngineConfigApply(null);
  }, []);

  // Hydrate from any active-profile engineConfig already loaded in localStorage.
  useEffect(() => {
    const cfg = GestureSettingsStore.get().engineConfig;
    if (cfg) {
      setConfigState((prev) => ({ ...prev, ...cfg }));
    }
  }, []);

  const setConfig = useCallback((patch: Partial<EngineConfig>) => {
    setConfigState((prev) => {
      const next = { ...prev, ...patch };
      if (engineRef.current) engineRef.current.config = next;
      // Mirror the calibration into the gesture-settings store so it rides
      // along when the user clicks "Save profile" and is synced to the cloud.
      GestureSettingsStore.patch({
        engineConfig: {
          sensitivity: next.sensitivity,
          smoothingAlpha: next.smoothingAlpha,
          clickThreshold: next.clickThreshold,
          releaseThreshold: next.releaseThreshold,
          scrollSensitivity: next.scrollSensitivity,
          aspectRatio: next.aspectRatio,
          deadZone: next.deadZone,
        },
      });
      return next;
    });
  }, []);

  const initialize = useCallback(async () => {
    setError(null);
    TelemetryStore.set({ emergencyStop: false, sensorLost: false });
    setInitializing(true);
    setStatus("Requesting camera access...");
    try {
      if (typeof window !== "undefined" && !window.isSecureContext) {
        throw new Error(
          "Camera blocked: getUserMedia requires a secure context. " +
          "Use http://localhost (not your LAN IP) or HTTPS.",
        );
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Camera API unavailable. Use a Chromium-based browser (Chrome/Edge/Brave) on the latest version.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      setProgress(25);

      const video = document.getElementById("omnipoint-video") as HTMLVideoElement | null;
      const canvas = document.getElementById("omnipoint-canvas") as HTMLCanvasElement | null;
      if (!video || !canvas) throw new Error("Sensor surface not mounted");
      video.srcObject = stream;
      // Wait for metadata so width/height are known before MediaPipe inference.
      await new Promise<void>((resolve) => {
        if (video.readyState >= 1 && video.videoWidth > 0) return resolve();
        const onMeta = () => { video.removeEventListener("loadedmetadata", onMeta); resolve(); };
        video.addEventListener("loadedmetadata", onMeta);
      });
      // play() can reject when the element is briefly hidden during init —
      // swallow the rejection; the stream is attached and MediaPipe will pull
      // frames as soon as the element becomes visible.
      try { await video.play(); } catch { /* autoplay deferred — frames still flow */ }
      // Wait for at least one decoded frame so detectForVideo has data.
      await new Promise<void>((resolve) => {
        if (video.readyState >= 2) return resolve();
        const onData = () => { video.removeEventListener("loadeddata", onData); resolve(); };
        video.addEventListener("loadeddata", onData);
      });
      setProgress(45);

      const bridge = new HIDBridge(bridgeUrl);
      bridgeRef.current = bridge;
      TelemetryStore.set({ bridgeUrl });
      // In browser-only mode we bypass the WebSocket entirely — gestures
      // are consumed locally by BrowserCursor through the TelemetryStore.
      if (controlMode === "bridge") {
        bridge.connect();
      } else {
        TelemetryStore.set({
          wsState: "connected",
          bridgeValidated: true,
          bridgeProbe: "ok",
          bridgeProbeMsg: "Browser-only mode",
        });
      }

      const engine = new GestureEngine(video, canvas, bridge, config);
      engineRef.current = engine;
      setStatus("Loading vision runtime...");
      setProgress(60);
      await engine.init((m) => {
        setStatus(m);
        setProgress((p) => Math.min(95, p + 12));
      });
      setProgress(100);
      setStatus("Sensor online.");
      engine.start();
      TelemetryStore.set({ initialized: true });
      setInitialized(true);
      setInitializing(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setInitializing(false);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [bridgeUrl, config, controlMode]);

  useEffect(() => {
    if (engineRef.current) engineRef.current.config = config;
  }, [config]);

  useEffect(() => {
    TelemetryStore.set({ bridgeUrl });
  }, [bridgeUrl]);

  // React to control mode changes after init: connect / disconnect the
  // bridge and flip the validated flag accordingly.
  useEffect(() => {
    if (!initialized || !bridgeRef.current) return;
    const bridge = bridgeRef.current;
    if (controlMode === "bridge") {
      TelemetryStore.set({
        bridgeValidated: false,
        bridgeProbe: "probing",
        bridgeProbeMsg: "Switched to bridge mode — probing…",
      });
      bridge.rearm();
      bridge.setUrl(bridgeUrl);
      bridge.probe();
    } else {
      // Browser-only: stop network traffic, keep telemetry "validated" so
      // the GestureEngine still emits packets that BrowserCursor consumes.
      bridge.emergencyStop();
      TelemetryStore.set({
        wsState: "connected",
        bridgeValidated: true,
        bridgeProbe: "ok",
        bridgeProbeMsg: "Browser-only mode",
        emergencyStop: false,
      });
    }
  }, [controlMode, initialized, bridgeUrl]);

  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      bridgeRef.current?.emergencyStop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleEmergencyToggle = useCallback(() => {
    const b = bridgeRef.current;
    if (!b) return;
    if (TelemetryStore.get().emergencyStop) {
      b.rearm();
    } else {
      b.emergencyStop();
    }
  }, []);

  const handleReconnect = useCallback(() => {
    if (!bridgeRef.current) return;
    bridgeRef.current.invalidate();
    bridgeRef.current.setUrl(bridgeUrl);
  }, [bridgeUrl]);

  const handleTestBridge = useCallback(async () => {
    if (!bridgeRef.current) {
      const tmp = new HIDBridge(bridgeUrl);
      await tmp.probe();
      return;
    }
    bridgeRef.current.setUrl(bridgeUrl);
    await bridgeRef.current.probe();
  }, [bridgeUrl]);

  const handleSetOrigin = useCallback(() => {
    engineRef.current?.setOrigin();
  }, []);

  const showInit = !initialized;

  return useMemo(
    () => (
      <main className="h-[100dvh] w-screen flex flex-col bg-background text-foreground overflow-hidden">
        <h1 className="sr-only">OmniPoint HCI — Live Sensor</h1>
        {!showInit && <StatusBar onEmergencyToggle={handleEmergencyToggle} />}
        {!showInit && (
          <ControlModeBar
            controlMode={controlMode}
            onControlModeChange={setControlMode}
            cursorMode={browserCursor.mode}
            onCursorModeChange={browserCursor.setMode}
            onClearDrawing={browserCursor.clearDrawing}
          />
        )}
        {!showInit && (
          <div className="absolute top-2 right-2 z-50 flex items-center gap-1.5 sm:gap-2">
            <TelemetryQualityBadge />
            {/* On mobile/tablet the telemetry side-panel becomes a slide-up sheet */}
            <Sheet>
              <SheetTrigger asChild>
                <button
                  className="lg:hidden font-mono text-[10px] tracking-[0.3em] px-3 h-9 inline-flex items-center gap-1.5 border hairline text-muted-foreground hover:text-foreground bg-card/60 backdrop-blur"
                  aria-label="Open telemetry panel"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  TELEMETRY
                </button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="w-[92vw] sm:w-[420px] p-0 overflow-y-auto bg-card"
              >
                <TelemetryPanel
                  config={config}
                  setConfig={setConfig}
                  bridgeUrl={bridgeUrl}
                  setBridgeUrl={setBridgeUrl}
                  onReconnect={handleReconnect}
                  onTestBridge={handleTestBridge}
                  onOpenTroubleshooter={() => setTroubleshooterOpen(true)}
                />
              </SheetContent>
            </Sheet>
            <GestureSettingsPanel />
            <button
              onClick={() => setTourOpen(true)}
              title="Show gesture guide"
              className="font-mono text-[10px] tracking-[0.3em] px-3 h-9 inline-flex items-center gap-1.5 border hairline text-muted-foreground hover:text-foreground bg-card/60 backdrop-blur"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              GUIDE
            </button>
            <button
              onClick={() => setCalibrationOpen(true)}
              title="Re-run calibration"
              className="font-mono text-[10px] tracking-[0.3em] px-3 h-9 inline-flex items-center gap-1.5 border hairline text-muted-foreground hover:text-foreground bg-card/60 backdrop-blur"
            >
              <Wand2 className="w-3.5 h-3.5" />
              CALIBRATE
            </button>
            <Link
              to="/"
              className="font-mono text-[10px] tracking-[0.3em] px-3 h-9 inline-flex items-center border hairline text-muted-foreground hover:text-foreground bg-card/60 backdrop-blur"
            >
              ← HOME
            </Link>
          </div>
        )}
        <div
          className={`flex-1 min-h-0 gap-2 p-2 flex ${showInit ? "invisible absolute inset-0 pointer-events-none" : ""}`}
        >
          <div className="flex-1 min-w-0 flex flex-col">
            <SensorPanel onSetOrigin={handleSetOrigin} />
          </div>
          {/* Side panel only visible on lg+ — replaced by the Sheet on mobile */}
          <div className="hidden lg:flex">
            <TelemetryPanel
              config={config}
              setConfig={setConfig}
              bridgeUrl={bridgeUrl}
              setBridgeUrl={setBridgeUrl}
              onReconnect={handleReconnect}
              onTestBridge={handleTestBridge}
              onOpenTroubleshooter={() => setTroubleshooterOpen(true)}
            />
          </div>
        </div>
        {showInit && (
          <div className="flex-1 relative">
            <div className="absolute top-3 left-3 z-50">
              <Link
                to="/"
                className="font-mono text-[10px] tracking-[0.3em] px-3 h-9 inline-flex items-center border hairline text-muted-foreground hover:text-foreground bg-card/60 backdrop-blur"
              >
                ← HOME
              </Link>
            </div>
            <InitScreen
              status={status}
              progress={progress}
              error={error}
              onInitialize={initialize}
              initializing={initializing}
              controlMode={controlMode}
              onControlModeChange={setControlMode}
            />
          </div>
        )}
        <BridgeTroubleshooter
          open={troubleshooterOpen}
          onClose={() => setTroubleshooterOpen(false)}
          bridgeUrl={bridgeUrl}
          setBridgeUrl={setBridgeUrl}
          onTestBridge={handleTestBridge}
        />
        {!showInit && controlMode === "browser" && browserCursor.mode === "draw" && (
          <>
            <PaintToolbar
              onClear={browserCursor.clearDrawing}
              onUndo={browserCursor.undo}
              onRedo={browserCursor.redo}
              onSave={browserCursor.saveAsPng}
              onCrop={browserCursor.cropSelection}
              onTogglePinchOverlay={() => setPinchOverlayOn((v) => !v)}
              pinchOverlayOn={pinchOverlayOn}
              getCanvas={browserCursor.getCanvas}
            />
            <PinchConfidenceOverlay
              visible={pinchOverlayOn}
              onClose={() => setPinchOverlayOn(false)}
            />
          </>
        )}
        <ThemeSettings variant="floating" />
        {!showInit && <PerformanceHUD />}
        {!showInit && (
          <CalibrationWizard
            forceOpen={calibrationOpen}
            config={config}
            setConfig={setConfig}
            onSetOrigin={handleSetOrigin}
            onClose={() => setCalibrationOpen(false)}
          />
        )}
        {!showInit && (
          <GestureTour
            forceOpen={tourOpen}
            onClose={() => setTourOpen(false)}
            autoShow
          />
        )}
      </main>
    ),
    [showInit, status, progress, error, initialize, initializing, config, setConfig, bridgeUrl, handleEmergencyToggle, handleReconnect, handleSetOrigin, handleTestBridge, troubleshooterOpen, calibrationOpen, tourOpen, controlMode, browserCursor.mode, browserCursor.setMode, browserCursor.clearDrawing, browserCursor.undo, browserCursor.redo, browserCursor.saveAsPng],
  );
};

export default Demo;
