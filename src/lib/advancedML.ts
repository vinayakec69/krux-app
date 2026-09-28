import * as ort from 'onnxruntime-web';

export class PlasticClassifier {
  private session: ort.InferenceSession | null = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  // The 9 classes your custom YOLOv8 model was trained on
  private readonly CLASS_NAMES = [
    'HDPE_A', 'HDPE_B', 'LDPE_A', 'LDPE_B', 
    'MISC_A', 'PET_A', 'PET_B', 'PP_A', 'PP_B'
  ];

  async init() {
    if (this.session) return;
    if (this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = new Promise(async (resolve, reject) => {
      try {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = false;
        
        this.session = await ort.InferenceSession.create('/model/best.onnx', {
          executionProviders: ['wasm']
        });
        console.log('Custom YOLOv8 ONNX model loaded successfully (WASM)');
        resolve();
      } catch (error) {
        console.error('Failed to load ONNX model:', error);
        this.session = null;
        reject(error);
      } finally {
        this.isInitializing = false;
      }
    });

    return this.initPromise;
  }

  async classify(imageData: ImageData): Promise<{ type: string; confidence: number; allScores: Record<string, number> }> {
    try {
      await this.init();
    } catch (initError) {
      console.error('Model initialization failed, using fallback:', initError);
      return this.fallbackClassification(imageData);
    }
    
    if (!this.session) {
      return this.fallbackClassification(imageData);
    }

    try {
      const tensor = this.preprocess(imageData);
      
      const feeds: Record<string, ort.Tensor> = {};
      feeds[this.session.inputNames[0]] = tensor;
      
      const results = await this.session.run(feeds);
      
      const output = results[this.session.outputNames[0]];
      const rawScores = output.data as Float32Array;
      
      // YOLOv8-cls output is ALREADY probabilities (softmax is baked in)
      // DO NOT apply softmax again — that was causing all scores to collapse to ~10%
      const probabilities = Array.from(rawScores);

      // Log raw probabilities for debugging
      console.log('[ML] Raw model output:', this.CLASS_NAMES.map((n, i) => `${n}:${(probabilities[i]*100).toFixed(1)}%`).join(', '));

      const scores: Record<string, number> = {
        PET: probabilities[5] + probabilities[6],
        HDPE: probabilities[0] + probabilities[1],
        LDPE: probabilities[2] + probabilities[3],
        PP: probabilities[7] + probabilities[8],
        OTHER: probabilities[4],
        PVC: 0.0,
        PS: 0.0
      };

      let bestType = 'UNKNOWN';
      let highestScore = 0;
      
      for (const [type, score] of Object.entries(scores)) {
        if (score > highestScore) {
          highestScore = score;
          bestType = type;
        }
      }

      console.log('[ML] Merged scores:', Object.entries(scores).map(([k,v]) => `${k}:${(v*100).toFixed(1)}%`).join(', '));
      console.log(`[ML] Classification: ${bestType} (${(highestScore*100).toFixed(1)}%)`);

      // Lower threshold since merged classes (PET_A + PET_B) should easily exceed this
      if (highestScore < 0.15) {
         return {
           type: 'UNKNOWN',
           confidence: highestScore,
           allScores: scores
         };
      }

      return {
        type: bestType,
        confidence: highestScore,
        allScores: scores
      };
    } catch (error) {
      console.error('Classification error, using fallback:', error);
      return this.fallbackClassification(imageData);
    }
  }

  private fallbackClassification(imageData: ImageData): { type: string; confidence: number; allScores: Record<string, number> } {
    const scores: Record<string, number> = {
      PET: 0, HDPE: 0, PVC: 0, LDPE: 0, PP: 0, PS: 0, OTHER: 0
    };
    return {
      type: 'UNKNOWN',
      confidence: 0,
      allScores: scores
    };
  }

  private preprocess(imageData: ImageData): ort.Tensor {
    const width = 320;
    const height = 320;
    
    // Create an offscreen canvas to resize the image to 320x320
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    
    // Put original image data into a temporary canvas
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    tempCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
    
    // Draw and scale down to 320x320
    ctx.drawImage(tempCanvas, 0, 0, width, height);
    
    const resizedImageData = ctx.getImageData(0, 0, width, height).data;
    
    // YOLOv8 classification expects float32 array in BCHW format (Batch, Channel, Height, Width)
    // with values normalized to [0, 1]
    const float32Data = new Float32Array(3 * width * height);
    
    // Convert from NHWC (Interleaved RGBARGBA) to NCHW (Planar RRRGGGBBB)
    for (let i = 0; i < width * height; i++) {
      float32Data[i] = resizedImageData[i * 4] / 255.0; // R
      float32Data[width * height + i] = resizedImageData[i * 4 + 1] / 255.0; // G
      float32Data[2 * width * height + i] = resizedImageData[i * 4 + 2] / 255.0; // B
    }

    return new ort.Tensor('float32', float32Data, [1, 3, height, width]);
  }

  private softmax(arr: number[]): number[] {
    const max = Math.max(...arr);
    const exp = arr.map(x => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp.map(x => x / sum);
  }
}

export const plasticClassifier = new PlasticClassifier();
