FROM fritz-agent

USER root

# C/C++ toolchain
RUN apt-get update && apt-get install -y \
    build-essential cmake ninja-build gdb \
    clang clang-tools \
    pkg-config zlib1g-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Additional build tools and multimedia/graphics dependencies
RUN apt-get update && apt-get install -y \
    make llvm lld \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    libglib2.0-dev libgl1-mesa-dev libglu1-mesa-dev \
    libsm-dev libx11-dev libx11-xcb-dev libexpat-dev \
    libxkbcommon-dev libxcb1-dev libxcb-glx0-dev \
    libxcb-icccm4-dev libxcb-image0-dev libxcb-keysyms1-dev \
    libxcb-randr0-dev libxcb-render0-dev libxcb-render-util0-dev \
    libxcb-shape0-dev libxcb-shm0-dev libxcb-sync-dev \
    libxcb-xfixes0-dev libxcb-xinerama0-dev libxcb-xkb-dev \
    libxcb-util-dev libpulse-dev libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

# Enable parallel builds by default (6 cores)
ENV MAKEFLAGS="-j6"
ENV CMAKE_BUILD_PARALLEL_LEVEL="6"

USER node
