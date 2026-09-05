# JENIFY LABS — ZERO-ADDITIONAL-COST CAPABILITY ARCHITECTURE RESEARCH

> **Document Version:** 1.0.0
> **Date:** 2026-08-22
> **Status:** APPROVED ARCHITECTURE RESEARCH (Design & Strategy Only — Zero Production Code Changes)
> **Target Entity:** Jenify Labs (R&D, Product Design, Studio Production, & Software Systems)
> **Constraint Mandate:** Zero additional recurring cash burn first; maximize pre-paid subscriptions (ChatGPT Plus, Claude Max 20x, Google AI Pro); leverage open-source/local tools; pay only for unavoidable real-world costs (e.g. physical hardware, mandatory store distribution fees).

---

## EXECUTIVE SUMMARY

Jenify Labs can operate at studio-grade and enterprise software execution capacity with **$0/month in mandatory additional recurring SaaS/API fees**. By pairing our existing pre-paid high-tier AI subscriptions (Claude Max 20x, ChatGPT Plus, Google AI Pro) with local open-source tooling, free-tier cloud hosting, local GPU execution, and open-access model runtimes, standard $50,000/month agency pipelines can be compressed into a zero-variable-cost local workstation pipeline.

---

## SECTION 1: TOP 5 ARCHITECTURAL PRINCIPLES & STRATEGIES

1. **Maximized Subscription UI Orchestration over Pay-Per-Token APIs**
   - *Strategy:* Never instantiate pay-per-token LLM/Vision API keys (e.g., OpenAI API, Anthropic API) for internal synthesis, code generation, asset drafting, or script writing. Instead, maximize interactive web interfaces, workspace integrations, and deep-reasoning modes of already paid tier subscriptions (Claude Max 20x for architecture and codebase synthesis, ChatGPT Plus with O1/O3 for logic/math reasoning, Google AI Pro / Gemini Advanced for ultra-long 2M-token context analysis and multimodal review).

2. **Simulation-First & Virtual Hardware Prototyping**
   - *Strategy:* Zero physical hardware spend during design, testing, and validation phases. Utilize open-source robotic and physics simulators (ROS 2 + Gazebo, Webots), circuit/microcontroller emulators (Wokwi, QEMU, SPICE), and virtualized IoT mesh networks (MQTT brokers on Docker local). Physical bill of materials (BOM) hardware is purchased only when a virtual prototype passes 100% automated test coverage.

3. **Local Workstation GPU Acceleration for Generative & Heavy Compute**
   - *Strategy:* Self-host generative AI media pipelines (ComfyUI, Stable Diffusion / Flux, Whisper, Piper TTS, Bark, Audiocraft) and 3D rendering (Blender Cycles GPU) on consumer local workstation GPUs (NVIDIA RTX 3090/4090/5090 class or Apple Silicon Unified Memory). Perform zero cloud rendering or cloud AI media processing unless local hardware is completely throttled, in which case serverless spot GPUs are rented on-demand with strict hard caps.

4. **Zero-Lock-in Open-Source Stack (Commercially Viable)**
   - *Strategy:* Standardize all software, media, and engine frameworks on permissive open-source software (MIT, Apache 2.0, BSD-3, CC0, MPL) or royalty-tiered enterprise engines with zero upfront cost (Unreal Engine 5). Strictly avoid copyleft AGPL/GPL in distributed proprietary binaries, and audit open weights for commercial usage restrictions (e.g. Llama 3 commercial threshold vs Flux.1 Dev non-commercial bounds).

5. **Edge-First, Free-Tier Cloud Deployment Matrix**
   - *Strategy:* Architect software for zero-cost cloud hosting using free edge/serverless compute and static hosting (GitHub Pages, Cloudflare Pages/Workers, Vercel/Netlify Free, Supabase Free Tier, Fly.io / Railway free tiers, Oracle Cloud Always Free ARM/x86 VPS instances). Production databases use local-first engines (SQLite/Turso, DuckDB, Embedded RocksDB) or self-hosted PostgreSQL on free cloud VPS nodes.

---

## SECTION 2: CAPABILITY DOMAINS & RECOMMENDED EXACT STACK

| Domain | Recommended Primary Stack | Secondary / Alternative Stack | Operational Execution Strategy |
|---|---|---|---|
| **Desktop Apps** | **Tauri 2.0 (Rust + Web Frontend)**, Electron | Flutter Desktop, PySide6 / Qt6 | Multi-platform build compiled locally or via GitHub Actions Free CI runners. Low memory footprint via Tauri. |
| **Mobile Apps** | **Flutter (Dart)**, React Native / Expo | Swift (iOS native), Kotlin (Android native) | Local emulator execution; free GitHub Actions runners for iOS `.ipa` and Android `.apk`/`.aab` builds. |
| **Websites & Web Apps** | **Vite + React / Next.js / Astro** | SvelteKit, Hugo / Eleventy | Static & SSR deployment on Cloudflare Pages / Vercel Free / GitHub Pages. Zero hosting fee. |
| **Software / SaaS / Platforms** | **Node.js / Fastify, Rust (Axum), Go** | Python (FastAPI), Elixir (Phoenix) | Local SQLite / Drizzle ORM / Turso Free. Microservices hosted on Cloudflare Workers / Fly.io / Oracle Free VPS. |
| **Hardware / IoT & Embedded** | **KiCad 8.0, ESP-IDF, FreeRTOS, Rust Embedded** | Arduino IDE / PlatformIO, QEMU | Wokwi web simulator for ESP32/STM32/Raspberry Pi Pico; SPICE circuit simulation; KiCad PCB design. |
| **Robots & Autonomy** | **ROS 2 (Humble/Jazzy), Gazebo Harmonic** | Webots, Isaac Sim (Local RTX required) | Physics & sensor simulation in Gazebo/Webots; URDF modeling; Python/C++ autonomy stack tested in sim. |
| **Games & Interactive** | **Unreal Engine 5.5, Godot 4.3** | Bevy (Rust), Phaser.js (2D Web) | Godot (100% free MIT) for 2D/3D lightweight games; Unreal Engine 5 for AAA visuals (0% royalty under $1M gross). |
| **Multimedia, VFX & Movies** | **Blender 4.x (Cycles/Eevee), DaVinci Resolve (Free)** | Kdenlive, Natron (VFX compositor), OpenToonz | Blender for 3D VFX/CGI; DaVinci Resolve for 4K color grading & editing; OpenToonz for 2D animation. |
| **Songs & Audio Production** | **Reaper (Discounted/Unrestricted Evaluation), Ardour** | Audacity, Tenacity, LMMS, Vital Synth | Local VST3 open-source instruments (Vital, Surge XT); AI stems split via local Demucs; local TTS/AI vocals. |
| **3D Assets & CAD** | **Blender 4.x, FreeCAD, OpenSCAD** | Plasticity (CAD), ArmorPaint / Texture Lab | Parametric CAD in FreeCAD/OpenSCAD; polygonal modeling, sculpting, and UV unwrapping in Blender. |
| **AI Media Generation** | **ComfyUI (Local SDXL / Flux.1 / Wan2.1)** | Automatic1111, LM Studio (Local LLM), Ollama | Local inference via ComfyUI nodes for image, video, and audio generation on local workstation GPU. |
| **Physical & Virtual Sims** | **Gazebo, Bullet Physics, OpenFOAM (CFD)** | Blender Physics, Mujoco (DeepMind open-source) | Aerodynamics/fluid dynamics via OpenFOAM; rigid body physics via Bullet/Mujoco; robotics via Gazebo. |
| **Automated Testing & QA** | **Playwright, Vitest, PyTest, Robot Framework** | Cypress, K6 (Performance testing) | Headless local browser testing and CI pipeline integration on GitHub Actions. |
| **Deployment & CI/CD** | **GitHub Actions, Docker, Cloudflare Workers** | Oracle Always Free Cloud (4 ARM cores, 24GB RAM) | Multi-arch Docker images built via GitHub Actions; deployment to free edge nodes or local bare-metal. |
| **Automation & Orchestration** | **n8n (Self-Hosted Community Edition)** | Windmill (Self-hosted open source), Node-RED | Self-hosted n8n container running locally or on Oracle Free VPS for workflow automation & webhooks. |

---

## SECTION 3: SUBSCRIPTION MAXIMIZATION STRATEGY

We hold three top-tier active AI subscriptions. **Zero API tokens will be purchased.** The following workflow leverages their specialized strengths via web UIs, extensions, and workspace interfaces:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 JENIFY LABS INTAKE                     │
                  └───────────────────────────┬────────────────────────────┘
                                              │
         ┌────────────────────────────────────┼────────────────────────────────────┐
         ▼                                    ▼                                    ▼
┌──────────────────┐               ┌──────────────────┐               ┌──────────────────┐
│  CLAUDE MAX 20X  │               │   CHATGPT PLUS   │               │  GOOGLE AI PRO   │
├──────────────────┤               ├──────────────────┤               ├──────────────────┤
│ • Codebase Arch  │               │ • Math/Logic/O1  │               │ • 2M Token Context│
│ • System Prompts │               │ • Canvas Editing │               │ • Multimodal Video│
│ • Complex Logic  │               │ • Data Analysis  │               │ • Web Research    │
│ • API Spec Design│               │ • Python Scripts │               │ • Doc Analysis    │
└────────┬─────────┘               └────────┬─────────┘               └────────┬─────────┘
         │                                  │                                  │
         └──────────────────────────────────┼──────────────────────────────────┘
                                            ▼
                  ┌────────────────────────────────────────────────────────┐
                  │              LOCAL PIPELINE / EXECUTION                │
                  │   (ComfyUI, Ollama, VS Code, Git, CI/CD, Blender)     │
                  └────────────────────────────────────────────────────────┘
```

1. **Claude Max 20x (Anthropic):**
   - *Primary Role:* Chief System Architect, Core Code Generator, Refactoring Engine, and Technical Writer.
   - *Execution:* Upload multi-file codebases, OpenAPI specifications, and architecture documents directly into Claude Projects. Utilize long-form code generation and high-turn conversational capacity for complete module implementations.

2. **ChatGPT Plus (OpenAI):**
   - *Primary Role:* Logic & Algorithmic Solver (o1/o3-mini reasoning), Canvas Interactive Editing, Data Analysis, and Python Automation Scripting.
   - *Execution:* Use Deep Research mode for market analysis; use Advanced Data Analysis to run local sandbox computations, transform datasets, parse raw CAD/sensor logs, and write complex regex/AST transformations.

3. **Google AI Pro (Gemini Advanced 1.5 Pro / 2.0 Flash):**
   - *Primary Role:* Ultra-Long Context Analysis (2M tokens), Video/Audio Multimodal Parsing, Live Web Grounding.
   - *Execution:* Feed entire repository archives, 1-hour screen-recordings of software bugs, PDF hardware datasheets, and 500-page standards documentation into Gemini for instant indexing, cross-referencing, and retrieval.

---

## SECTION 4: LOCAL VS FREE CLOUD VS ON-DEMAND GPU EXECUTION MATRIX

```
+---------------------------------------------------------------------------------------+
|                                    EXECUTION MATRIX                                   |
+-----------------------------------+-----------------------------------+---------------+
| LOCAL WORKSTATION                 | FREE CLOUD INFRASTRUCTURE         | ON-DEMAND GPU |
| (0 Cash Cost)                     | ($0 Cash Cost)                    | (Low Variable)|
+-----------------------------------+-----------------------------------+---------------+
| • Code Editing & IDEs             | • Web Hosting (Cloudflare Pages)  | • Large Scale |
| • Local Build/Compile (Tauri/Rust)| • Edge Serverless (Cloudflare)    |   3D Renders   |
| • Local LLM (Ollama/LM Studio)    | • GitHub Actions CI (2k mins/mo)  |   (Vast.ai)   |
| • Image Gen (SDXL / Flux ComfyUI) | • DB Hosting (Supabase/Turso Free)| • Multi-Hour  |
| • Video Editing & Audio DAW       | • Oracle Always Free VPS          |   AI Video Gen|
| • CAD & 3D Modeling (Blender)     |   (4 ARM Cores, 24GB RAM, 200GB)  |   (RunPod)    |
| • Robotics Sim (ROS 2 / Gazebo)   | • Artifact Registry (GitHub Packages)|            |
+-----------------------------------+-----------------------------------+---------------+
```

---

## SECTION 5: MEDIA & VFX PIPELINE ARCHITECTURE

For serious studio-quality movies, 2D/3D animation, VFX, music, and voiceovers without studio software fees ($0/mo software burn):

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                MEDIA & VFX PIPELINE                                     │
├─────────────────┬──────────────────┬──────────────────┬────────────────┬────────────────┤
│ 1. SCRIPT &     │ 2. 3D & ASSETS   │ 3. AI MEDIA &    │ 4. AUDIO &     │ 5. EDITING,    │
│    STORYBOARD   │    GENERATION    │    SYNTHESIS     │    VOICEOVER   │    COLOR & VFX │
├─────────────────┼──────────────────┼──────────────────┼────────────────┼────────────────┤
│ • ChatGPT /     │ • Blender 4.x    │ • ComfyUI        │ • Reaper DAW   │ • DaVinci      │
│   Claude        │   (Modeling/Rig) │   (Flux.1 / SDXL)│ • Vital Synth  │   Resolve      │
│ • Storyboarder  │ • OpenSCAD       │ • Wan2.1 Video   │ • Bark / Piper │ • Natron VFX   │
│   (Open-Source) │ • Poly Pizza     │   Generation     │   Local TTS    │ • Handbrake    │
│                 │   (CC0 Assets)   │ • AnimateDiff    │ • Demucs Split │   Encoder      │
└─────────────────┴──────────────────┴──────────────────┴────────────────┴────────────────┘
```

---

## SECTION 6: HARDWARE & ROBOTICS PROTOTYPING PIPELINE

To prototype IoT hardware and robotics with **zero physical component burn** until final hardware manufacturing:

1. **Schematic & PCB Design:** KiCad 8.0 (100% Free Open Source). Fully features multi-layer PCB design, 3D PCB visualization, and Gerber file generation for manufacturing.
2. **Circuit & Microcontroller Emulation:** Wokwi Simulator (ESP32, STM32, Arduino, Raspberry Pi Pico) + SPICE (analog circuit simulation).
3. **Robotics Kinematics & Physics Simulation:** ROS 2 (Robot Operating System) + Gazebo Harmonic Simulator. Simulates LiDAR, cameras, IMUs, wheel kinematics, and robotic arms under realistic gravity and friction.
4. **Firmware Development:** Embedded Rust / C++ (ESP-IDF) built locally and unit-tested inside QEMU / Gazebo virtual hardware targets.

---

## SECTION 7: LICENSE & COMMERCIAL-USE MATRIX

| Software / Model / Asset | License Type | Commercial Use Allowed? | Restrictions / Thresholds / Notes | Official Verification Link |
|---|---|---|---|---|
| **Tauri 2.0** | MIT / Apache 2.0 | YES | 100% Free for commercial use. | [tauri.app](https://tauri.app/) |
| **Flutter** | BSD 3-Clause | YES | 100% Free for commercial use. | [flutter.dev](https://flutter.dev/) |
| **Godot Engine 4.x** | MIT | YES | 100% Free, no royalties, no revenue cap. | [godotengine.org](https://godotengine.org/license/) |
| **Unreal Engine 5.x** | Royalty-based | YES (Tiered) | Free up to $1,000,000 USD gross revenue per game/app; 5% royalty thereafter. | [unrealengine.com](https://www.unrealengine.com/en-US/license) |
| **Blender 4.x** | GNU GPL v3 | YES | Free for commercial projects. 3D output/renders created with Blender are 100% owned by the creator. | [blender.org](https://www.blender.org/about/license/) |
| **DaVinci Resolve (Free)** | Freeware Commercial | YES | Free version allowed for commercial production; Studio version ($295 flat) adds extra GPU FX. | [blackmagicdesign.com](https://www.blackmagicdesign.com/products/davinciresolve) |
| **ROS 2 & Gazebo** | Apache 2.0 / BSD | YES | 100% Free for commercial robotics development. | [ros.org](https://ros.org/) |
| **KiCad 8.0** | GPL v3 / CC-BY-SA | YES | Schematics and PCB layouts created with KiCad are owned 100% by author; software is free. | [kicad.org](https://www.kicad.org/about/licenses/) |
| **Flux.1 Schnell (Black Forest Labs)** | Apache 2.0 | YES | Open weights, commercial use explicitly permitted. | [huggingface.co/black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell) |
| **Flux.1 Dev** | Non-Commercial | NO (Paid License Required) | Free for non-commercial/research only. | [huggingface.co/black-forest-labs/FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev) |
| **Llama 3.1 / 3.3 (Meta)** | Llama 3.1 Community License | YES | Commercial use free up to 700 million monthly active users. | [llama.meta.com](https://llama.meta.com/license/) |
| **SDXL 1.0 (Stability AI)** | OpenRAIL-M | YES | Commercial use allowed subject to standard responsible AI usage terms. | [huggingface.co/stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) |

---

## SECTION 8: TIERED STRATEGY BREAKDOWN & VARIABLE COST ESTIMATES

### TIER 1: FREE STRATEGY ($0.00 / month)
- **Execution:** 100% local GPU/CPU compute, free cloud static/edge hosting, pre-paid ChatGPT Plus / Claude Max 20x / Google AI Pro web UIs, Godot 4, Blender 4, DaVinci Resolve Free, Tauri, Flutter, ROS 2, Gazebo, KiCad, Supabase Free Tier, Oracle Always Free VPS.
- **Estimated Monthly Variable Cost:** **$0.00**
- **Target Deliverables:** SaaS platforms, mobile apps, desktop software, 2D/3D games, robotics simulations, web platforms, marketing videos, full music tracks, firmware binaries.

### TIER 2: VERY CHEAP STRATEGY ($10.00 – $50.00 / month)
- **Execution:** Tier 1 + custom domain names ($10/yr per domain), on-demand serverless GPU rendering (Vast.ai / RunPod spot instances at $0.20–$0.40/hr for heavy SDXL/Wan2.1 video batch rendering, total 20–50 hours/mo = ~$10–$25), minor cloud storage overflow (Hetznar Storage Box / Cloudflare R2 zero-egress fee).
- **Estimated Monthly Variable Cost:** **$15.00 – $45.00**
- **Target Deliverables:** Monetized commercial SaaS apps with custom domains, studio 4K film rendering, high-throughput media generation campaigns.

### TIER 3: BUDGET STRATEGY ($50.00 – $200.00 / month)
- **Execution:** Tier 2 + Dedicated Cloud VPS (Hetzner Dedicated / Netcup $40–$80/mo for persistent databases & self-hosted CI runners), Apple Developer Account ($99/yr = ~$8.25/mo) & Google Play Console ($25 one-time), targeted cloud GPU bursts for complex 3D VFX rendering.
- **Estimated Monthly Variable Cost:** **$60.00 – $180.00**
- **Target Deliverables:** App Store & Google Play published mobile apps, multi-region database replication, production high-concurrency SaaS platforms.

---

## SECTION 9: STORAGE, DEPLOYMENT, CI/CD & AUTOMATION INFRASTRUCTURE

1. **Storage Infrastructure:**
   - *Local:* Local NAS / NVMe SSD arrays for high-speed raw media, 3D caches, and AI checkpoints.
   - *Cloud:* Cloudflare R2 (10 GB free tier storage, 10M read requests/mo, **$0 egress fees**) or Hetzner Storage Box ($3.50/mo for 1 TB).

2. **Deployment & Hosting Infrastructure:**
   - *Frontend / Web:* Cloudflare Pages / Vercel Free / GitHub Pages ($0/mo).
   - *Backend API / Microservices:* Cloudflare Workers / Fly.io free tier / Oracle Always Free Cloud (4 Ampere ARM cores, 24 GB RAM, 200 GB storage = $0/mo forever).

3. **CI/CD Infrastructure:**
   - *GitHub Actions:* 2,000 free build minutes/month for public/private repositories. Local self-hosted GitHub Actions runners on workstation for unlimited build minutes.

4. **Automation & Orchestration:**
   - Self-hosted **n8n (Community Edition)** running inside Docker on Oracle Always Free VPS or local workstation. Connects webhooks, Git events, automated notifications, and database tasks with zero Zapier/Make SaaS fees.

---

## SECTION 10: FALLBACK STRATEGIES & RESILIENCE

1. **API / Subscription Throttling Fallback:**
   - If Claude Max or ChatGPT reach message limits during heavy work sessions, fallback seamlessly to **Google AI Pro (Gemini 1.5 Pro/2.0 Flash)** which offers generous high-rate web limits, or to **Local LLMs via Ollama / LM Studio** (DeepSeek-R1-Distill-Qwen-32B, Llama-3.3-70B GGUF) running locally.

2. **Hardware / Compute Failure Fallback:**
   - If local workstation GPU is occupied with 3D rendering or unavailable, offload background AI image/video batches to on-demand spot GPU instances on **Vast.ai** ($0.20/hr RTX 3090) with auto-terminating scripts.

3. **Cloud Free Tier Over-Quota Fallback:**
   - If Cloudflare Workers or Supabase limits are approached, failover API traffic to self-hosted Fastify/Node containers running on the Oracle Always Free ARM cluster.

---

## SECTION 11: VERIFIABLE CURRENT SOURCES & CITATIONS

1. **Tauri 2.0 Security & Licensing:** [https://tauri.app/](https://tauri.app/)
2. **Flutter Open Source License (BSD-3):** [https://flutter.dev/](https://flutter.dev/)
3. **Unreal Engine 5 Royalty Terms ($1M Exemption):** [https://www.unrealengine.com/en-US/license](https://www.unrealengine.com/en-US/license)
4. **Godot Engine MIT License:** [https://godotengine.org/license/](https://godotengine.org/license/)
5. **Blender GNU GPL Terms:** [https://www.blender.org/about/license/](https://www.blender.org/about/license/)
6. **DaVinci Resolve Commercial Usage Statement:** [https://www.blackmagicdesign.com/products/davinciresolve](https://www.blackmagicdesign.com/products/davinciresolve)
7. **Black Forest Labs Flux.1 License Specs:** [https://huggingface.co/black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)
8. **Meta Llama 3.1 Community License:** [https://llama.meta.com/license/](https://llama.meta.com/license/)
9. **Oracle Cloud Always Free Tier Specifications:** [https://www.oracle.com/cloud/free/](https://www.oracle.com/cloud/free/)
10. **Cloudflare Free Tier & R2 Zero-Egress Terms:** [https://www.cloudflare.com/plans/](https://www.cloudflare.com/plans/)
