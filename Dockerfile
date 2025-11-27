FROM node:18

# Install Ghostscript (required for PDF compression)
RUN apt-get update && apt-get install -y ghostscript

# Create working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Copy the rest of the project files
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
