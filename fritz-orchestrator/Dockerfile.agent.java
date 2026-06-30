FROM fritz-agent

USER root

# Java toolchain via Eclipse Adoptium (OpenJDK 21 not in Bookworm repos)
RUN apt-get update \
    && apt-get install -y wget gpg \
    && wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/trusted.gpg.d/adoptium.gpg \
    && echo "deb https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update \
    && apt-get install -y temurin-21-jdk maven unzip procps \
    && rm -rf /var/lib/apt/lists/*

# Gradle with checksum verification
RUN GRADLE_VERSION=8.12 \
    && GRADLE_DIST=gradle-${GRADLE_VERSION}-bin.zip \
    && wget https://services.gradle.org/distributions/${GRADLE_DIST} -P /tmp \
    && wget https://services.gradle.org/distributions/${GRADLE_DIST}.sha256 -P /tmp \
    && cd /tmp \
    && echo "$(cat ${GRADLE_DIST}.sha256)  ${GRADLE_DIST}" | sha256sum -c - \
    && unzip -d /opt/gradle /tmp/${GRADLE_DIST} \
    && ln -s /opt/gradle/gradle-${GRADLE_VERSION}/bin/gradle /usr/bin/gradle \
    && rm /tmp/${GRADLE_DIST} /tmp/${GRADLE_DIST}.sha256

# Architecture-independent JAVA_HOME symlink
RUN arch="$(dpkg --print-architecture)" \
    && ln -sfn "/usr/lib/jvm/temurin-21-jdk-${arch}" /usr/lib/jvm/java-21-openjdk

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"
ENV MAVEN_OPTS="-Xmx512m -XX:MaxMetaspaceSize=256m"
ENV GRADLE_HOME=/opt/gradle/gradle-8.12

# Add Maven/Gradle cache dirs for node user
RUN mkdir -p /home/node/.m2/repository /home/node/.gradle \
    && chown -R node:node /home/node/.m2 /home/node/.gradle

USER node
