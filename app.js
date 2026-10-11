const header = document.querySelector('[data-header]');
const menuToggle = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('.mobile-menu');
const reserveForm = document.querySelector('#reserve-form');
const menuButtons = document.querySelectorAll('[data-filter]');
const dishes = document.querySelectorAll('[data-category]');

window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

menuToggle?.addEventListener('click', () => {
  const open = mobileMenu.classList.toggle('is-open');
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
});

mobileMenu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  mobileMenu.classList.remove('is-open');
  menuToggle?.setAttribute('aria-expanded', 'false');
}));

menuButtons.forEach((button) => button.addEventListener('click', () => {
  menuButtons.forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  const filter = button.dataset.filter;
  dishes.forEach((dish) => {
    const visible = filter === 'todos' || dish.dataset.category === filter;
    dish.hidden = !visible;
  });
}));

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.section-head, .dish-card, .story-collage, .story-copy, .reserve-copy, .reserve-form, .closing-content').forEach((element) => {
  element.classList.add('reveal');
  revealObserver.observe(element);
});

reserveForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(reserveForm);
  const name = data.get('name');
  const people = data.get('people');
  const date = data.get('date');
  const note = data.get('note');
  const message = `Hola, soy ${name}. Me gustaría reservar una mesa para ${people} el ${date}.${note ? ` Nota: ${note}` : ''}`;
  let preview = document.querySelector('#reservation-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'reservation-preview';
    preview.className = 'reservation-preview';
    preview.setAttribute('role', 'status');
    reserveForm.append(preview);
  }
  preview.textContent = `Demostración: no se ha enviado ninguna reserva. En la web del cliente, este mensaje se abriría en su WhatsApp: ${message}`;
});
