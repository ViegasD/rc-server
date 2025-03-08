# Usa a imagem oficial do Node.js
FROM node:20

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia o package.json e o package-lock.json para instalar as dependências
COPY package*.json ./

# Instala as dependências do projeto
RUN npm install

# Copia todos os arquivos do projeto para o diretório de trabalho
COPY . .

# Expõe a porta em que o servidor Node.js irá rodar (padrão 3000)
EXPOSE 3200

# Comando para rodar o servidor
CMD ["node", "server.js"]
