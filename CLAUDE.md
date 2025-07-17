# Supabase Storage Engine - Claude Development Guide

## Project Overview

The Supabase Storage Engine is a scalable, lightweight object storage service that provides multi-protocol support for file storage operations. This codebase implements a storage API that integrates with PostgreSQL for metadata storage and supports various storage backends including S3-compatible services.

## Architecture

### Core Components

1. **Multi-Protocol Support**
   - HTTP/REST API for standard file operations
   - TUS (Transloadit Upload Server) for resumable uploads
   - S3-compatible API for AWS S3 client compatibility
   - Iceberg REST Catalog for data lake functionality

2. **Database Integration**
   - Uses PostgreSQL as the primary datastore for metadata
   - Authorization implemented via PostgreSQL Row Level Security (RLS) policies
   - Single-tenant architecture for simplified deployment

3. **Storage Backends**
   - Integrates with S3-compatible storage services
   - Supports multiple storage adapters through a flexible backend system

## Project Structure

```
/src
├── admin-app.ts        # Admin application entry point
├── app.ts              # Main application entry point
├── config.ts           # Configuration management
├── http/               # HTTP server and routing
│   ├── routes/         # API route implementations
│   │   ├── admin/      # Admin-specific routes
│   │   ├── bucket/     # Bucket management
│   │   ├── object/     # Object operations
│   │   ├── s3/         # S3-compatible API
│   │   └── tus/        # TUS protocol implementation
│   └── plugins/        # Fastify plugins
├── storage/            # Core storage functionality
│   ├── backend/        # Storage backend adapters
│   ├── database/       # Database operations
│   ├── protocols/      # Protocol implementations
│   └── renderer/       # Image transformation
└── internal/           # Internal utilities
    ├── auth/           # Authentication/authorization
    ├── database/       # Database utilities
    └── monitoring/     # Logging and metrics
```

## Key Technical Details

### Authentication & Authorization
- JWT-based authentication with support for multiple signing secrets
- Row Level Security (RLS) policies for fine-grained access control
- Support for API keys and service role tokens

### Storage Features
- Bucket creation and management
- Object upload, download, and deletion
- Public and private file access
- Signed URLs for temporary access
- Image transformation and rendering
- CDN integration with cache purging

### Database Schema
- Single-tenant architecture for simplified deployment
- Migrations managed in `/migrations/tenant` directory
- Single database schema for all operations

### Development Setup

1. **Environment Configuration**
   ```bash
   # Set up your environment variables
   # Create .env file with required configuration
   # See the configuration section in src/config.ts for all available options
   ```

2. **Infrastructure Setup**
   ```bash
   npm run infra:restart  # Sets up PostgreSQL and PostgREST via Docker
   npm run dev           # Starts the storage server
   ```

3. **Testing**
   ```bash
   npm test              # Run the test suite
   ```

## API Endpoints

### Bucket Operations
- `POST /bucket` - Create a new bucket
- `GET /bucket` - List all buckets
- `GET /bucket/:id` - Get bucket details
- `PUT /bucket/:id` - Update bucket settings
- `DELETE /bucket/:id` - Delete a bucket

### Object Operations
- `POST /object/:bucket/*` - Upload an object
- `GET /object/:bucket/*` - Download an object
- `DELETE /object/:bucket/*` - Delete an object
- `POST /object/move` - Move/rename an object
- `POST /object/copy` - Copy an object

### S3-Compatible API
The service implements a subset of the S3 API for compatibility with existing S3 clients.

### Admin Operations
Admin endpoints are available under `/admin/*` for system operations.

## Development Guidelines

### Code Organization
- Keep route handlers in appropriate directories under `/src/http/routes`
- Storage backend logic belongs in `/src/storage/backend`
- Database operations should use the adapter pattern in `/src/storage/database`
- Shared utilities go in `/src/internal`

### Error Handling
- Use typed errors from `/src/internal/errors`
- Implement proper error codes for client-friendly responses
- Log errors appropriately for debugging

### Testing
- Write tests for new features in the `/src/test` directory
- Use the test utilities in `/src/test/utils` for common operations
- Ensure database migrations are tested

### Performance Considerations
- The service is designed to be lightweight and performant
- Use streaming for large file operations
- Implement proper connection pooling for database operations
- Monitor metrics via the built-in monitoring system

## External Resources

- [OpenAPI Specification](https://supabase.github.io/storage)
- [Storage Guides](https://supabase.io/docs/guides/storage)
- [Client Library Documentation](https://supabase.io/docs/reference/javascript/storage-createbucket)

## Important Notes

- This is a single-tenant system designed for simplified deployment
- Authorization is critical - ensure RLS policies are properly configured
- The service integrates with various Supabase components
- Performance and scalability are key design goals
- Uses a fixed tenant ID (`storage-single-tenant`) throughout the system