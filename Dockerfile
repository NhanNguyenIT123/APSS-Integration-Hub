FROM node:20-bullseye

# Cài đặt thư mục làm việc
WORKDIR /app

# Copy file cài đặt thư viện
COPY package*.json ./

# Cài đặt các thư viện Node.js
RUN npm install

# BẮT BUỘC CHO RENDER: Cài đặt trình duyệt ảo Chromium và các thư viện hệ điều hành (Ubuntu) đi kèm
RUN npx playwright install --with-deps chromium

# Copy toàn bộ mã nguồn còn lại
COPY . .

# Mở cổng mạng
EXPOSE 3000

# Lệnh khởi động server
CMD ["npm", "start"]
