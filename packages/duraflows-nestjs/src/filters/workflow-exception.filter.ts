import { Catch, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { WorkflowError, WorkflowInstanceNotFoundError, InvalidEventError, InvalidArgumentError } from "@duraflows/core";

// `send()` (unlike `json()`) exists on both Express and Fastify replies, and
// both serialize a plain object to JSON — keep this filter platform-agnostic.
interface HttpResponseLike {
  status(code: number): { send(body: unknown): void };
}

/**
 * Maps duraflows domain errors to HTTP statuses for the optional REST
 * controllers. Without this filter, a missing instance or an event invalid
 * for the current state surfaces as a generic 500 and leaks internal
 * messages.
 */
@Catch(WorkflowError)
export class WorkflowExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(WorkflowExceptionFilter.name);

  catch(exception: WorkflowError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();

    if (exception instanceof WorkflowInstanceNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).send({
        statusCode: HttpStatus.NOT_FOUND,
        error: "Not Found",
        message: exception.message,
      });
      return;
    }

    if (exception instanceof InvalidEventError) {
      response.status(HttpStatus.CONFLICT).send({
        statusCode: HttpStatus.CONFLICT,
        error: "Conflict",
        message: exception.message,
      });
      return;
    }

    if (exception instanceof InvalidArgumentError) {
      response.status(HttpStatus.BAD_REQUEST).send({
        statusCode: HttpStatus.BAD_REQUEST,
        error: "Bad Request",
        message: exception.message,
      });
      return;
    }

    // The response body is sanitized, so log the real cause here — otherwise
    // unmapped domain errors (e.g. optimistic-locking conflicts under
    // concurrency) become undiagnosable silent 500s. `WorkflowError` wraps the
    // originating DI/persistence failure as `cause` (e.g. NestCommandRegistry
    // attaches the container error), so prefer the cause's message and stack —
    // the wrapper alone hides the underlying failure from operators.
    const cause = exception.cause instanceof Error ? exception.cause : undefined;
    this.logger.error(
      cause ? `${exception.message} (cause: ${cause.message})` : exception.message,
      (cause ?? exception).stack,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "Internal server error",
    });
  }
}
