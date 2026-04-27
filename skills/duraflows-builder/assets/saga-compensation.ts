/**
 * Saga Pattern with Compensation
 *
 * Pattern: Forward execution chain with rollback on failure.
 * Domain:  Travel booking -- reserve flight, reserve hotel, charge payment.
 *          If payment fails, cancel hotel and flight reservations.
 *
 * Flow:
 *   initiated -> (Book) -> reserving_flight -> reserving_hotel -> charging_payment -> confirmed
 *                          |                    |                    |
 *                          v                    v                    v (compensation chain)
 *                       flight_failed      cancelling_flight    cancelling_hotel -> cancelling_flight -> booking_failed
 *
 * Key design points:
 * - Forward steps use onEnter chains (gateway states)
 * - Compensation steps also use onEnter chains (reverse order)
 * - Each step stores its reservation ID in context so compensation knows what to cancel
 * - Compensation commands should be idempotent
 * - v1.0.0: compensation commands set `bestEffort: true` — a failed cancel is
 *   recorded in history but does NOT halt the rollback chain. Without
 *   bestEffort, a failed cancel-hotel would block the cancel-flight that
 *   follows it, leaving the saga half-rolled-back.
 */

import type { WorkflowDefinition, WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

// ---------------------------------------------------------------------------
// 1. Workflow Definition
// ---------------------------------------------------------------------------

export const travelBookingWorkflow: WorkflowDefinition = {
  name: "travel-booking",
  initialState: "initiated",
  states: {
    initiated: {
      context: {
        status: "initiated",
        flightReservationId: null,
        hotelReservationId: null,
        paymentChargeId: null,
      },
      events: {
        Book: {
          targetState: "reserving_flight",
        },
      },
    },

    // --- Forward chain (onEnter) ---

    reserving_flight: {
      context: { status: "reserving_flight" },
      onEnter: {
        targetState: "reserving_hotel",
        errorState: "flight_failed",
        commands: [{ name: "reserveFlight" }],
      },
    },

    reserving_hotel: {
      context: { status: "reserving_hotel" },
      onEnter: {
        targetState: "charging_payment",
        errorState: "hotel_failed_cancelling_flight", // hotel fails -> compensate flight
        commands: [{ name: "reserveHotel" }],
      },
    },

    charging_payment: {
      context: { status: "charging_payment" },
      onEnter: {
        targetState: "confirmed",
        errorState: "payment_failed_cancelling_hotel", // payment fails -> compensate hotel then flight
        commands: [{ name: "chargePayment" }],
      },
    },

    confirmed: {
      context: { status: "confirmed" },
      events: {
        Cancel: {
          targetState: "cancelling_hotel", // user-initiated cancellation: full compensation
        },
      },
    },

    // --- Failure states (no compensation needed) ---

    flight_failed: {
      context: { status: "flight_failed" },
      events: {
        Retry: {
          targetState: "reserving_flight",
        },
      },
    },

    // --- Compensation chains ---

    // Hotel failed: only need to cancel flight
    hotel_failed_cancelling_flight: {
      context: { status: "compensating" },
      onEnter: {
        targetState: "booking_failed",
        commands: [{ name: "cancelFlight" }],
      },
    },

    // Payment failed: cancel hotel, then flight
    payment_failed_cancelling_hotel: {
      context: { status: "compensating" },
      onEnter: {
        targetState: "payment_failed_cancelling_flight",
        commands: [{ name: "cancelHotel" }],
      },
    },

    payment_failed_cancelling_flight: {
      context: { status: "compensating" },
      onEnter: {
        targetState: "booking_failed",
        commands: [{ name: "cancelFlight" }],
      },
    },

    // User-initiated cancellation: cancel hotel, then flight
    cancelling_hotel: {
      context: { status: "cancelling" },
      onEnter: {
        targetState: "cancelling_flight",
        commands: [{ name: "cancelHotel" }],
      },
    },

    cancelling_flight: {
      context: { status: "cancelling" },
      onEnter: {
        targetState: "cancelled",
        commands: [{ name: "cancelFlight" }],
      },
    },

    // --- Terminal states ---

    booking_failed: {
      context: { status: "booking_failed" },
      events: {
        Retry: {
          targetState: "reserving_flight", // start fresh
        },
      },
    },

    cancelled: {
      context: { status: "cancelled" },
      // terminal state
    },
  },
};

// ---------------------------------------------------------------------------
// 2. Example Command Implementations
// ---------------------------------------------------------------------------

// Forward commands: perform the action and store the result in context

export class ReserveFlightCommand implements WorkflowCommand {
  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    // Idempotency: skip if already reserved
    if (ctx.context.flightReservationId) {
      return { ok: true, code: "ALREADY_RESERVED" };
    }

    try {
      // const reservation = await flightService.reserve(subject);
      const reservationId = "FLT-" + Date.now(); // placeholder
      ctx.context.flightReservationId = reservationId;
      ctx.context.flightReservedAt = ctx.now.toISOString();
      return { ok: true, code: "FLIGHT_RESERVED", metadata: { reservationId } };
    } catch (err) {
      return { ok: false, code: "FLIGHT_RESERVE_FAILED", message: String(err) };
    }
  }
}

export class ReserveHotelCommand implements WorkflowCommand {
  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    if (ctx.context.hotelReservationId) {
      return { ok: true, code: "ALREADY_RESERVED" };
    }

    try {
      // const reservation = await hotelService.reserve(subject);
      const reservationId = "HTL-" + Date.now(); // placeholder
      ctx.context.hotelReservationId = reservationId;
      ctx.context.hotelReservedAt = ctx.now.toISOString();
      return { ok: true, code: "HOTEL_RESERVED", metadata: { reservationId } };
    } catch (err) {
      return { ok: false, code: "HOTEL_RESERVE_FAILED", message: String(err) };
    }
  }
}

export class ChargePaymentCommand implements WorkflowCommand {
  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    if (ctx.context.paymentChargeId) {
      return { ok: true, code: "ALREADY_CHARGED" };
    }

    try {
      // const charge = await paymentService.charge({ amount, idempotencyKey: ctx.metadata.bookingId });
      const chargeId = "CHG-" + Date.now(); // placeholder
      ctx.context.paymentChargeId = chargeId;
      ctx.context.chargedAt = ctx.now.toISOString();
      return { ok: true, code: "PAYMENT_CHARGED", metadata: { chargeId } };
    } catch (err) {
      return { ok: false, code: "PAYMENT_FAILED", message: String(err) };
    }
  }
}

// Compensation commands: undo previous actions using IDs stored in context.
// v1.0.0: marked `bestEffort: true` so a failed cancel records the failure in
// history but does NOT abort the rest of the compensation chain.

export class CancelFlightCommand implements WorkflowCommand {
  readonly bestEffort = true;

  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const reservationId = ctx.context.flightReservationId as string | null;
    if (!reservationId) {
      return { ok: true, code: "NOTHING_TO_CANCEL" };
    }

    // Let the cancel call throw or return ok:false naturally — bestEffort
    // captures it without halting the chain.
    // await flightService.cancel(reservationId);
    ctx.context.flightReservationId = null;
    ctx.context.flightCancelledAt = ctx.now.toISOString();
    return { ok: true, code: "FLIGHT_CANCELLED" };
  }
}

export class CancelHotelCommand implements WorkflowCommand {
  readonly bestEffort = true;

  async execute(_subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const reservationId = ctx.context.hotelReservationId as string | null;
    if (!reservationId) {
      return { ok: true, code: "NOTHING_TO_CANCEL" };
    }

    // await hotelService.cancel(reservationId);
    ctx.context.hotelReservationId = null;
    ctx.context.hotelCancelledAt = ctx.now.toISOString();
    return { ok: true, code: "HOTEL_CANCELLED" };
  }
}

// ---------------------------------------------------------------------------
// 3. Usage Example
// ---------------------------------------------------------------------------

/*
const instance = await runtime.createInstance({
  workflowName: "travel-booking",
  metadata: { bookingId: "BK-001", customerId: "CUST-123" },
});

const handle = runtime.getHandle(instance.uuid);

// Trigger the saga -- entire forward chain runs in one transaction:
// initiated -> reserving_flight -> reserving_hotel -> charging_payment -> confirmed
const result = await handle.triggerEvent("Book");

if (result.toState === "confirmed") {
  console.log("Booking confirmed!");
} else if (result.toState === "booking_failed") {
  // A step failed and compensation ran automatically
  console.log("Booking failed, all reservations compensated");
} else if (result.toState === "flight_failed") {
  // First step failed, nothing to compensate
  // Can retry:
  await handle.triggerEvent("Retry");
}

// User-initiated cancellation (after confirmed):
// await handle.triggerEvent("Cancel");
// Runs: cancelling_hotel -> cancelling_flight -> cancelled
*/
