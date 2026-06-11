import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { WorkflowError, WorkflowInstanceNotFoundError, InvalidEventError } from "@duraflows/core";

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}

/**
 * Maps duraflows domain errors to HTTP statuses for the optional REST
 * controllers. Without this filter, a missing instance or an event invalid
 * for the current state surfaces as a generic 500 and leaks internal
 * messages.
 */
@Catch(WorkflowError)
export class WorkflowExceptionFilter implements ExceptionFilter {
  catch(exception: WorkflowError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();

    if (exception instanceof WorkflowInstanceNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: "Not Found",
        message: exception.message,
      });
      return;
    }

    if (exception instanceof InvalidEventError) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: "Conflict",
        message: exception.message,
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "Internal server error",
    });
  }
}
