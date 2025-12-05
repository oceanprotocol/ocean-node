FROM ubuntu:22.04 as base
RUN apt-get update && apt-get -y install bash curl git wget libatomic1 python3 build-essential
COPY .nvmrc /usr/src/app/
RUN rm /bin/sh && ln -s /bin/bash /bin/sh
ENV NVM_DIR /usr/local/nvm
RUN mkdir $NVM_DIR
ENV NODE_VERSION=v22.12.0 
# Install nvm with node and npm
RUN curl https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash \
    && source $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default
ENV NODE_PATH $NVM_DIR/$NODE_VERSION/lib/node_modules
ENV PATH $NVM_DIR/versions/node/$NODE_VERSION/bin:$PATH
ENV IPFS_GATEWAY='https://ipfs.io/'
ENV ARWEAVE_GATEWAY='https://arweave.net/'

FROM base as builder
COPY package*.json /usr/src/app/
WORKDIR /usr/src/app/
RUN npm ci --maxsockets 1


FROM base as runner
COPY . /usr/src/app
WORKDIR /usr/src/app/
COPY --from=builder /usr/src/app/node_modules/ /usr/src/app/node_modules/
RUN npm run build
# Remove the controlpanel folder to reduce the image size and avoid shipping development files
RUN rm -rf controlpanel
ENV P2P_ipV4BindTcpPort=9000
EXPOSE 9000
ENV P2P_ipV4BindWsPort=9001
EXPOSE 9001
ENV P2P_ipV6BindTcpPort=9002
EXPOSE 9002
ENV P2P_ipV6BindWsPort=9003
EXPOSE 9003
ENV HTTP_API_PORT=8000
EXPOSE 8000
ENV NODE_ENV='production'
CMD ["npm","run","start"]
