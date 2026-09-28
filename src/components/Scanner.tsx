import { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Zap, AlertTriangle, CheckCircle, RotateCcw, Loader2, Shield, QrCode, Trash2, ArrowRight } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { plasticClassifier } from '@/lib/advancedML';
import { fraudDetector } from '@/lib/advancedFraudDetection';
import { generateScanMetadata } from '@/utils/fraudDetection';
import { initiateHandshake, validateScan, listenForDropConfirmation } from '@/services/api';
import type { PlasticType } from '@/lib/plasticClassificationService';

const PLASTIC_INFO: Record<PlasticType, { name: string; examples: string; color: string; coins: number }> = {
  PET: { name: 'PET (Polyethylene Terephthalate)', examples: 'Water bottles, soft drink bottles', color: '#22c55e', coins: 15 },
  HDPE: { name: 'HDPE (High-Density Polyethylene)', examples: 'Milk jugs, detergent bottles', color: '#3b82f6', coins: 12 },
  PVC: { name: 'PVC (Polyvinyl Chloride)', examples: 'Pipes, cable insulation', color: '#f59e0b', coins: 8 },
  LDPE: { name: 'LDPE (Low-Density Polyethylene)', examples: 'Plastic bags, squeeze bottles', color: '#8b5cf6', coins: 10 },
  PP: { name: 'PP (Polypropylene)', examples: 'Yogurt containers, bottle caps', color: '#ec4899', coins: 11 },
  PS: { name: 'PS (Polystyrene)', examples: 'Foam cups, packing peanuts', color: '#06b6d4', coins: 7 },
  OTHER: { name: 'Other/Mixed Plastics', examples: 'Multi-layer packaging', color: '#6b7280', coins: 5 },
};

type ScanState = 
  | 'idle' 
  | 'requesting' 
  | 'scanning_qr'      // Phase 1: Auto-scanning for QR code
  | 'handshake'         // Connecting to Bin
  | 'streaming_plastic' // Phase 2: Scan Plastic Item
  | 'captured' 
  | 'processing' 
  | 'waiting_for_drop'  // Escrow Phase
  | 'result' 
  | 'fraud';

interface ScanResult {
  type: PlasticType;
  confidence: number;
  coins: number;
}

interface FraudResult {
  isFraud: boolean;
  confidence: number;
  reason: string;
}

export const Scanner = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const qrScanIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [fraudResult, setFraudResult] = useState<FraudResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [allScores, setAllScores] = useState<Record<string, number>>({});
  
  // IoT Escrow State
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentBinId, setCurrentBinId] = useState<string | null>(null);
  const [dropTimeout, setDropTimeout] = useState<number>(30);
  const [qrDetected, setQrDetected] = useState<string | null>(null);

  const { addScan, addKrux, updateStreak, user } = useStore();
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
      stopQrScanning();
    };
  }, []);

  // Drop countdown timer
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (scanState === 'waiting_for_drop' && dropTimeout > 0) {
      timer = setInterval(() => setDropTimeout(prev => prev - 1), 1000);
    } else if (scanState === 'waiting_for_drop' && dropTimeout === 0) {
      setError('Time expired. Please try scanning again.');
      setScanState('idle');
    }
    return () => clearInterval(timer);
  }, [scanState, dropTimeout]);
  
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const stopQrScanning = () => {
    if (qrScanIntervalRef.current) {
      clearInterval(qrScanIntervalRef.current);
      qrScanIntervalRef.current = null;
    }
  };

  // ─── Start camera and begin auto-scanning for QR codes ───
  const startQrScan = useCallback(async () => {
    if (!user) {
      setError('Please login first to scan bins.');
      return;
    }

    setScanState('requesting');
    setError(null);
    setQrDetected(null);
    
    try {
      stopCamera();
      stopQrScanning();
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        
        await new Promise<void>((resolve, reject) => {
          if (!videoRef.current) { reject(new Error('Video element not found')); return; }
          const video = videoRef.current;
          video.onloadedmetadata = () => { video.play().then(() => resolve()).catch(reject); };
          video.onerror = () => reject(new Error('Video error'));
          setTimeout(() => reject(new Error('Camera timeout')), 10000);
        });
        
        setScanState('scanning_qr');
        
        // Start continuous QR scanning using BarcodeDetector API or jsQR fallback
        startAutoQrDetection();
      }
    } catch (err) {
      console.error('Camera error:', err);
      setError('Failed to access camera. Please allow permissions.');
      setScanState('idle');
    }
  }, [user]);

  // ─── Continuous QR detection ───
  const startAutoQrDetection = () => {
    stopQrScanning();

    // Try native BarcodeDetector first (Chrome Android supports it)
    const hasNativeDetector = 'BarcodeDetector' in window;
    let detector: any = null;

    if (hasNativeDetector) {
      try {
        detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        console.warn('BarcodeDetector init failed, using fallback');
      }
    }

    qrScanIntervalRef.current = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;

      const video = videoRef.current;

      // ── Method 1: Native BarcodeDetector (fast, runs on GPU) ──
      if (detector) {
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const qrValue = barcodes[0].rawValue;
            if (qrValue && qrValue.includes('KRUX_BIN_')) {
              handleQrDetected(qrValue);
              return;
            }
          }
        } catch (e) { /* ignore frame errors */ }
      }

      // ── Method 2: Canvas-based fallback using jsQR ──
      if (!detector) {
        try {
          const { default: jsQR } = await import('jsqr');
          const canvas = qrCanvasRef.current;
          if (!canvas) return;
          
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          
          ctx.drawImage(video, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          
          if (code && code.data.includes('KRUX_BIN_')) {
            handleQrDetected(code.data);
            return;
          }
        } catch (e) { /* jsQR not available, use mock fallback below */ }
      }
    }, 300); // Scan every 300ms
  };

  // ─── QR detected → Start handshake ───
  const handleQrDetected = async (qrValue: string) => {
    stopQrScanning();

    // Extract bin ID from QR value (e.g., "KRUX_BIN_001" or a URL containing it)
    let binId = qrValue;
    if (qrValue.includes('KRUX_BIN_')) {
      const match = qrValue.match(/KRUX_BIN_\d+/);
      if (match) binId = match[0];
    }

    setQrDetected(binId);
    setScanState('handshake');
    setCurrentBinId(binId);

    try {
      const response = await initiateHandshake(user!.id, binId);
      setCurrentSessionId(response.session_id);
      
      // SUCCESS: Bin responded! Proceed to plastic scanning
      startCamera('plastic');
    } catch (err: any) {
      setError(err.message || 'Failed to connect to bin. Is it online?');
      setScanState('idle');
    }
  };

  // ─── Mock QR (fallback for testing without a real QR code) ───
  const mockScanQR = async () => {
    handleQrDetected('KRUX_BIN_001');
  };

  const startCamera = useCallback(async (mode: 'plastic') => {
    setScanState('requesting');
    setError(null);
    
    try {
      stopCamera();
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        
        await new Promise<void>((resolve, reject) => {
          if (!videoRef.current) { reject(new Error('Video element not found')); return; }
          const video = videoRef.current;
          video.onloadedmetadata = () => { video.play().then(() => resolve()).catch(reject); };
          video.onerror = () => reject(new Error('Video error'));
          setTimeout(() => reject(new Error('Camera timeout')), 10000);
        });
        
        setScanState('streaming_plastic');
      }
    } catch (err) {
      console.error('Camera error:', err);
      setError('Failed to access camera. Please allow permissions.');
      setScanState('idle');
    }
  }, []);
  
  // STEP 2: Capture Plastic Image
  const capturePlastic = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(video, 0, 0);
    const imageDataObj = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    
    setCapturedImage(dataUrl);
    setScanState('captured');
    stopCamera();
    
    processImage(imageDataObj, dataUrl);
  }, [currentSessionId]);
  
  const processImage = async (imageDataObj: ImageData, dataUrl: string) => {
    if (!currentSessionId) {
      setError('No active bin session. Start over.');
      setScanState('idle');
      return;
    }

    setScanState('processing');
    setProgress(0);
    
    const progressSteps = [
      { target: 20, delay: 100 },
      { target: 45, delay: 150 },
      { target: 70, delay: 200 },
      { target: 82, delay: 300 },
      { target: 95, delay: 500 },
    ];
    
    let stepIndex = 0;
    const progressInterval = setInterval(() => {
      if (stepIndex < progressSteps.length) {
        setProgress(progressSteps[stepIndex].target);
        stepIndex++;
      }
    }, 200);
    
    try {
      const classification = await plasticClassifier.classify(imageDataObj);
      const plasticType = classification.type as PlasticType;
      const confidence = classification.confidence;
      const allScoresRes = classification.allScores;
      
      clearInterval(progressInterval);
      setProgress(100);
      
      await validateScan({
        session_id: currentSessionId,
        predicted_class: plasticType,
        confidence: confidence,
        image_hash: 'mock_hash_123', 
        perceptual_hash: 'mock_phash_123',
        bin_id: currentBinId || undefined,
      });

      setDropTimeout(30);
      setScanState('waiting_for_drop');

      const unsubscribe = listenForDropConfirmation(currentBinId || 'unknown_bin', async (event) => {
        if (event.status === 'confirmed') {
          const coins = event.krux_earned || PLASTIC_INFO[plasticType].coins;
          setScanResult({
            type: plasticType,
            confidence: confidence,
            coins: coins
          });
          setAllScores(allScoresRes);
          
          if (canvasRef.current && dataUrl) {
            const metadata = await generateScanMetadata(canvasRef.current, dataUrl);
            await addScan(plasticType, metadata, coins);
          } else {
            addKrux(coins);
            updateStreak();
          }
          
          setScanState('result');
          unsubscribe();
        } else if (event.status === 'failed') {
          setError(`Hardware rejected drop: ${event.reason}`);
          setScanState('idle');
          unsubscribe();
        }
      });
      
    } catch (err: any) {
      clearInterval(progressInterval);
      
      if (err.message && err.message.toLowerCase().includes('duplicate')) {
        setFraudResult({
          isFraud: true,
          confidence: 99,
          reason: 'Duplicate image detected by KRUX Anti-Fraud Engine.'
        });
        setScanState('fraud');
      } else {
        setError(err.message || 'Failed to validate scan. Please try again.');
        setScanState('idle');
      }
    }
  };
  
  const resetScanner = () => {
    stopCamera();
    stopQrScanning();
    setCapturedImage(null);
    setScanResult(null);
    setFraudResult(null);
    setError(null);
    setProgress(0);
    setAllScores({});
    setCurrentSessionId(null);
    setCurrentBinId(null);
    setQrDetected(null);
    setScanState('idle');
  };
  
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 pb-24">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">KRUX Scanner</h1>
          {currentBinId && (
            <div className="flex items-center gap-2 text-xs bg-green-100 text-green-700 px-3 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Connected: {currentBinId}
            </div>
          )}
        </div>
      </div>
      
      <canvas ref={canvasRef} className="hidden" />
      <canvas ref={qrCanvasRef} className="hidden" />
      
      <div className="p-4">
        <div className="relative aspect-[3/4] bg-gray-100 rounded-2xl overflow-hidden mb-4 border border-gray-200">
          
          {/* Video Stream */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`absolute inset-0 w-full h-full object-cover ${(scanState === 'scanning_qr' || scanState === 'streaming_plastic') ? 'block' : 'hidden'}`}
          />
          
          {capturedImage && scanState !== 'scanning_qr' && scanState !== 'streaming_plastic' && scanState !== 'idle' && scanState !== 'requesting' && (
            <img src={capturedImage} alt="Captured" className="absolute inset-0 w-full h-full object-cover" />
          )}
          
          {/* 1. IDLE STATE */}
          {scanState === 'idle' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
              <div
                onClick={startQrScan}
                className="w-24 h-24 rounded-full bg-green-500 flex items-center justify-center cursor-pointer hover:bg-green-600 transition-all hover:scale-105 shadow-md shadow-green-200"
              >
                <QrCode className="w-10 h-10 text-white" />
              </div>
              <p className="mt-6 text-gray-600 text-lg font-medium">Step 1: Scan KRUX Bin</p>
              <p className="mt-2 text-gray-400 text-sm">Point at the QR code on any smart bin to connect</p>
            </div>
          )}
          
          {/* Loading States */}
          {(scanState === 'requesting' || scanState === 'handshake') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/90">
              <Loader2 className="w-12 h-12 text-green-500 animate-spin" />
              <p className="mt-4 text-gray-600 font-medium">
                {scanState === 'requesting' ? 'Accessing Camera...' : 'Connecting securely to Bin...'}
              </p>
              {scanState === 'handshake' && qrDetected && (
                <p className="mt-2 text-green-600 text-sm font-bold">QR Detected: {qrDetected}</p>
              )}
            </div>
          )}
          
          {/* 2. AUTO-SCANNING FOR QR CODE */}
          {scanState === 'scanning_qr' && (
            <>
              <div className="absolute inset-0 pointer-events-none">
                {/* QR scanning overlay — corner brackets */}
                <div className="absolute inset-16">
                  {/* Top-left */}
                  <div className="absolute top-0 left-0 w-8 h-8 border-t-3 border-l-3 border-green-500 rounded-tl-lg" />
                  {/* Top-right */}
                  <div className="absolute top-0 right-0 w-8 h-8 border-t-3 border-r-3 border-green-500 rounded-tr-lg" />
                  {/* Bottom-left */}
                  <div className="absolute bottom-0 left-0 w-8 h-8 border-b-3 border-l-3 border-green-500 rounded-bl-lg" />
                  {/* Bottom-right */}
                  <div className="absolute bottom-0 right-0 w-8 h-8 border-b-3 border-r-3 border-green-500 rounded-br-lg" />
                </div>
                {/* Scanning line animation */}
                <div className="absolute left-16 right-16 h-0.5 bg-green-500 opacity-80" style={{ top: '50%', animation: 'qrScan 2s ease-in-out infinite' }} />
              </div>
              <div className="absolute top-6 left-0 right-0 text-center">
                <p className="text-white text-sm bg-black/60 inline-block px-4 py-2 rounded-full backdrop-blur-sm">
                  📷 Auto-scanning for QR Code...
                </p>
              </div>
              <div className="absolute bottom-6 left-0 right-0 flex justify-center">
                <button
                  onClick={mockScanQR}
                  className="flex items-center gap-2 px-6 py-3 bg-white/20 text-white text-sm font-bold rounded-full backdrop-blur-sm border border-white/30"
                >
                  <QrCode className="w-4 h-4" />
                  MOCK SCAN (Testing)
                </button>
              </div>
            </>
          )}

          {/* 3. STREAMING PLASTIC */}
          {scanState === 'streaming_plastic' && (
            <>
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-8 border-2 border-green-500/70 rounded-lg" />
              </div>
              <div className="absolute bottom-6 left-0 right-0 flex justify-center">
                <button
                  onClick={capturePlastic}
                  className="flex items-center gap-2 px-8 py-4 bg-green-500 text-white font-bold rounded-full shadow-md"
                >
                  <Camera className="w-5 h-5" />
                  ANALYZE PLASTIC
                </button>
              </div>
              <div className="absolute top-6 left-0 right-0 text-center">
                <p className="text-white text-sm bg-green-500/80 inline-block px-4 py-2 rounded-full">✅ Bin Connected! Scan your plastic item</p>
              </div>
            </>
          )}
          
          {/* 4. PROCESSING */}
          {scanState === 'processing' && (
            <div className="absolute inset-0 bg-white/90 flex flex-col items-center justify-center p-6">
              <div className="w-full max-w-xs text-center">
                <Loader2 className="w-8 h-8 text-green-500 animate-spin mx-auto mb-4" />
                <p className="text-green-700 font-bold mb-2">Analyzing & Validating...</p>
                <div className="h-3 bg-green-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* 5. WAITING FOR PHYSICAL DROP */}
          {scanState === 'waiting_for_drop' && (
            <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center p-6 text-center backdrop-blur-sm">
              <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mb-6 animate-pulse">
                <Trash2 className="w-10 h-10 text-green-400" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Scan Approved!</h2>
              <p className="text-gray-300 mb-6 text-lg">Please drop the item into the bin now.</p>
              
              <div className="bg-white/10 rounded-2xl p-4 border border-white/20 w-full max-w-xs">
                <p className="text-gray-400 text-sm mb-2">Awaiting hardware confirmation...</p>
                <div className="flex justify-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <p className="text-white font-mono font-bold text-xl">{dropTimeout}s</p>
              </div>
            </div>
          )}
          
          {/* Fraud Detected */}
          {scanState === 'fraud' && fraudResult && (
            <div className="absolute inset-0 bg-white/95 flex flex-col items-center justify-center p-6 text-center">
              <AlertTriangle className="w-16 h-16 text-red-500 mb-4" />
              <h2 className="text-2xl font-bold text-red-500 mb-2">Scan Rejected</h2>
              <p className="text-gray-600 mb-6">{fraudResult.reason}</p>
              <button onClick={resetScanner} className="px-6 py-3 bg-gray-100 text-gray-700 rounded-full font-bold">Start Over</button>
            </div>
          )}
          
          {/* Error */}
          {error && scanState === 'idle' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-white/90">
              <AlertTriangle className="w-12 h-12 text-red-500 mb-4" />
              <p className="text-red-500 font-medium mb-6">{error}</p>
              <button onClick={resetScanner} className="px-6 py-3 bg-green-500 text-white font-bold rounded-full">Reset Scanner</button>
            </div>
          )}
        </div>
        
        {/* 6. REWARD RESULT CARD */}
        {scanState === 'result' && scanResult && (
          <div className="space-y-4 animate-fade-in">
            <div className="bg-green-50 border border-green-200 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-green-500 flex items-center justify-center shadow-lg shadow-green-200">
                  <CheckCircle className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="text-xl font-black text-green-800">Drop Confirmed!</h3>
                  <p className="text-green-600 font-medium text-sm">IoT Bin synced successfully</p>
                </div>
              </div>
              
              <div className="flex items-center justify-between p-5 bg-white border border-green-100 rounded-2xl shadow-sm mb-4">
                <div className="flex items-center gap-4">
                  <div className="bg-green-100 p-3 rounded-xl">
                    <Zap className="w-8 h-8 text-green-500" />
                  </div>
                  <div>
                    <p className="text-green-600 font-black text-3xl">+{scanResult.coins}</p>
                    <p className="text-gray-500 font-bold text-sm">KRUX EARNED</p>
                  </div>
                </div>
              </div>

              {/* Material Classification Card */}
              <div className="p-4 bg-white border border-gray-200 rounded-2xl shadow-sm mb-4">
                <p className="text-xs text-gray-400 font-bold uppercase mb-2">ML Classification</p>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-lg font-black" style={{ color: PLASTIC_INFO[scanResult.type]?.color || '#059669' }}>
                      {PLASTIC_INFO[scanResult.type]?.name || scanResult.type}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">{PLASTIC_INFO[scanResult.type]?.examples}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-black text-gray-900">{Math.round(scanResult.confidence * 100)}%</p>
                    <p className="text-xs text-gray-400">Confidence</p>
                  </div>
                </div>
              </div>

              <button
                onClick={resetScanner}
                className="w-full py-4 bg-green-500 hover:bg-green-600 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-md shadow-green-200"
              >
                Scan Next Item
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
        
        {/* Info Section */}
        {scanState === 'idle' && (
          <div className="space-y-4">
            <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-900 mb-4">The KRUX Pipeline</h3>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold flex-shrink-0">1</div>
                  <p className="text-sm text-gray-600"><strong className="text-gray-900">Handshake:</strong> Point your camera at the QR code — it auto-detects and connects.</p>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold flex-shrink-0">2</div>
                  <p className="text-sm text-gray-600"><strong className="text-gray-900">Scan Plastic:</strong> Our ML model identifies the plastic type and prevents fraud.</p>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold flex-shrink-0">3</div>
                  <p className="text-sm text-gray-600"><strong className="text-gray-900">Physical Drop:</strong> Drop the item. The bin's IR sensor confirms it and releases your KRUX!</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      
      <style>{`
        @keyframes qrScan {
          0%, 100% { transform: translateY(-60px); opacity: 0.3; }
          50% { transform: translateY(60px); opacity: 1; }
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in { animation: fade-in 0.4s ease-out forwards; }
        .border-t-3 { border-top-width: 3px; }
        .border-b-3 { border-bottom-width: 3px; }
        .border-l-3 { border-left-width: 3px; }
        .border-r-3 { border-right-width: 3px; }
      `}</style>
    </div>
  );
}
