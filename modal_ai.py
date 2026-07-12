import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# 1. Initialize Modal App
app = modal.App("apss-ai-engine")

# 2. Configure Qwen2.5 Model
MODEL_NAME = "Qwen/Qwen2.5-Coder-7B-Instruct"

# 3. Create virtual environment (vLLM and FastAPI)
def download_model():
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL_NAME)

image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "vllm>=0.6.0",
        "fastapi",
        "hf_transfer"
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    .run_function(download_model) # Bake model into image for fast cold starts
)

# Initialize Web Server
web_app = FastAPI()

# 4. Configure AI Engine on A10G GPU (24GB VRAM)
with image.imports():
    from vllm.engine.arg_utils import AsyncEngineArgs
    from vllm.engine.async_llm_engine import AsyncLLMEngine
    from vllm.sampling_params import SamplingParams
    import uuid

@app.cls(gpu="A10G", scaledown_window=300, image=image, timeout=1200)
class AIEngine:
    @modal.enter()
    def setup(self):
        engine_args = AsyncEngineArgs(
            model=MODEL_NAME,
            tensor_parallel_size=1,
            gpu_memory_utilization=0.90,
            max_model_len=16384,
            enforce_eager=True
        )
        self.engine = AsyncLLMEngine.from_engine_args(engine_args)

    @modal.method()
    async def generate(self, prompt: str, temperature: float = 0.1, max_tokens: int = 8192):
        request_id = str(uuid.uuid4())
        sampling_params = SamplingParams(temperature=temperature, max_tokens=max_tokens)
        results_generator = self.engine.generate(prompt, sampling_params, request_id)
        
        final_output = None
        async for request_output in results_generator:
            final_output = request_output
            
        return final_output.outputs[0].text

# 5. Open API Endpoint mirroring local Ollama
@web_app.post("/api/generate")
async def api_generate(request: Request):
    data = await request.json()
    prompt = data.get("prompt", "")
    temp = data.get("options", {}).get("temperature", 0.1)
    max_tokens = data.get("options", {}).get("num_predict", 8192)
    
    # Call AI Engine remotely
    engine = AIEngine()
    text = await engine.generate.remote.aio(prompt, temp, max_tokens)
    
    return JSONResponse(content={"response": text})

# Wrap Web Server in Modal ASGI App
@app.function(image=image, timeout=1200)
@modal.asgi_app()
def fastapi_app():
    return web_app
