const { PrismaClient, Prisma } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();
  try {
    const order = await prisma.order.create({
      data: {
        paymentMethod: "cash",
        totalAmount: new Prisma.Decimal("200"),
        currency: "RUB",
        status: "PendingPayment",
        comment: "Тест: Эспрессо",
      },
    });

    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        name: "Эспрессо",
        price: new Prisma.Decimal("200"),
        quantity: 1,
      },
    });

    console.log("UTF8 OK. Created test order:", order.id);

    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("UTF8 TEST FAILED:", e);
  process.exit(1);
});

