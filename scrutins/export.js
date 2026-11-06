// export.js - Logique d'exportation PDF

document.addEventListener('DOMContentLoaded', () => {
  const btnExport = document.getElementById('btnExport');
  const pageContent = document.getElementById('pageContent');
  const cfgNumero = document.getElementById('cfgNumero');

  if (!btnExport) {
    console.warn("Bouton d'export introuvable.");
    return;
  }

  // === GESTION DE L'EXPORT PDF (CAPTURE D'ÉCRAN) ===
  btnExport.addEventListener('click', async () => {
    // 1. Appliquer la classe pour forcer la largeur et ajouter des marges
    pageContent.classList.add('exporting');
    
    // On attend un court instant pour s'assurer que le DOM est bien mis à jour
    await new Promise(r => setTimeout(r, 200));

    try {
      // 2. Prendre la capture d'écran
      const canvas = await html2canvas(pageContent, {
        scale: 2, 
        useCORS: true,
        backgroundColor: "#ffffff",
        scrollY: 0,
        scrollX: 0
      });

      // 3. Créer le PDF A4
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      
      const imgData = canvas.toDataURL('image/jpeg', 1.0);
      
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      
      const imgWidth = canvas.width;
      const imgHeight = canvas.height;
      
      // Calcul du ratio avec une marge de 10mm sur les côtés
      const margin = 10; // en mm
      const maxW = pdfWidth - (margin * 2);
      const maxH = pdfHeight - (margin * 2);
      
      const ratio = Math.min(maxW / imgWidth, maxH / imgHeight);
      
      const newImgWidth = imgWidth * ratio;
      const newImgHeight = imgHeight * ratio;
      
      // Centrage horizontal et vertical
      const x = (pdfWidth - newImgWidth) / 2;
      const y = (pdfHeight - newImgHeight) / 2;

      pdf.addImage(imgData, 'JPEG', x, y, newImgWidth, newImgHeight);

      // Récupérer le numéro du scrutin pour le nom du fichier
      const numero = cfgNumero ? cfgNumero.value : '0000';
      const fileName = `Analyse du scrutin n°${numero}.pdf`;
      pdf.save(fileName);

    } catch (error) {
      console.error("Erreur lors de l'export PDF :", error);
      alert("Une erreur est survenue lors de l'export PDF. Vérifiez la console pour plus de détails.");
    } finally {
      // 4. Retirer la classe d'exportation dans tous les cas
      pageContent.classList.remove('exporting');
    }
  });
});
